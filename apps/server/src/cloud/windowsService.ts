import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import packageJson from "../../package.json" with { type: "json" };
import {
  isCurrentServiceInstallation,
  serializeServiceInstallation,
} from "./serviceInstallation.ts";
import {
  BootService,
  BootServiceError,
  resolvePackagedDist,
  serviceInstanceId,
  type ServiceHost,
  type ServicePlan,
  type ServiceStatus,
} from "./bootService.ts";

export const powershellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const TaskState = Schema.Struct({
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  running: Schema.Boolean,
});
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(TaskState));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function renderWindowsTask(input: {
  sid: string;
  description: string;
  executable: string;
  launcher: string;
  cwd: string;
}) {
  if ([input.executable, input.launcher, input.cwd].some((value) => /["\r\n]/.test(value)))
    throw new Error("Invalid scheduled-task path.");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(input.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(input.sid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="User"><UserId>${xml(input.sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="User"><Exec><Command>${xml(input.executable)}</Command><Arguments>&quot;${xml(input.launcher)}&quot;</Arguments><WorkingDirectory>${xml(input.cwd)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

export function renderWindowsLauncher(plan: ServicePlan) {
  return `Object.assign(process.env, ${JSON.stringify(plan.environment)});\nprocess.argv = ${JSON.stringify(plan.arguments)};\nawait import(${JSON.stringify(pathToFileURL(plan.runtimePath).href)});\n`;
}

export async function makeWindowsService(input: {
  host: ServiceHost;
  baseDir: string;
  homeDir: string;
  executablePath: string;
  cliEntryPath: string;
  environment: NodeJS.ProcessEnv;
}) {
  const { host, baseDir } = input;
  const powershell = join(
    input.environment.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const run = async (script: string) => {
    const result = await host.run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; ${script}`,
      ],
      15_000,
    );
    if (result.code !== 0 || result.timedOut)
      throw new Error(
        result.stderr.trim() || "Windows Task Scheduler operation failed or timed out.",
      );
    return result.stdout.trim();
  };
  const sid = await run("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid))
    throw new Error("Cannot establish the current Windows user SID.");
  const instanceId = serviceInstanceId(baseDir.toLowerCase());
  const label = `T3Code-${serviceInstanceId(sid)}-${instanceId}`;
  const instanceDir = join(baseDir, "runtime", "background-service", instanceId);
  const paths = {
    instanceId,
    label,
    target: label,
    instanceDir,
    definitionPath: join(instanceDir, "task.xml"),
    lockPath: join(input.homeDir, ".t3-service-locks", `${instanceId}.lock`),
    runtimesDir: join(instanceDir, "runtimes"),
    versionPath: join(instanceDir, "version"),
    logPath: join(baseDir, "userdata", "logs", "server.log"),
    runtimeStatePath: join(instanceDir, "server-runtime.json"),
  };
  const description = `T3 Code managed host: ${baseDir}`;
  const connect = `$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\'); $task=$null; try {$task=$folder.GetTask(${powershellLiteral(label)})} catch {if ($_.Exception.GetBaseException().HResult -ne -2147024894) {throw}}; if ($task) { $taskSid=$task.Definition.Principal.UserId; if ($taskSid -notmatch '^S-1-') {$taskSid=([System.Security.Principal.NTAccount]::new($taskSid)).Translate([System.Security.Principal.SecurityIdentifier]).Value}; if ($taskSid -ne ${powershellLiteral(sid)}) {throw 'Refusing a scheduled task owned by another user.'}; if ($task.Definition.Principal.LogonType -ne 3) {throw 'Refusing a scheduled task without interactive user logon.'}; if ($task.Definition.RegistrationInfo.Description -ne ${powershellLiteral(description)}) {throw 'Refusing a scheduled task belonging to another T3 environment.'} };`;
  const state = async () =>
    decodeState(
      await run(
        `${connect} @{installed=($null -ne $task); enabled=($null -ne $task -and $task.Enabled); running=($null -ne $task -and $task.State -eq 4)} | ConvertTo-Json -Compress`,
      ),
    );
  const register = async (definition: string) => {
    await run(
      `${connect} $null=$folder.RegisterTask(${powershellLiteral(label)}, ${powershellLiteral(definition)}, 6, ${powershellLiteral(sid)}, $null, 3, $null)`,
    );
  };
  const privateDirectory = async () => {
    await run(
      `$base=${powershellLiteral(baseDir)}; $homePath=${powershellLiteral(input.homeDir)}; if (-not $base.StartsWith($homePath.TrimEnd('\\')+'\\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Windows managed hosts require a data directory inside your user profile.'}; foreach ($target in @($base,${powershellLiteral(paths.runtimesDir)},${powershellLiteral(paths.lockPath)})) { $p=$target; while (-not [IO.Directory]::Exists($p)) {if ([IO.File]::Exists($p)) {throw 'Expected a managed host directory'}; $p=[IO.Path]::GetDirectoryName($p)}; while ($p.Length -ge $homePath.Length) { if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Managed host directories must not contain junctions or symbolic links'}; $acl=Get-Acl -LiteralPath $p; $trusted=@(${powershellLiteral(sid)},'S-1-5-18','S-1-5-32-544'); $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if ($trusted -notcontains $owner) {throw 'The managed host directory has an untrusted owner.'}; foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band 0x000D0156) -ne 0) {throw 'The managed host directory is writable by another user.'}}; if ($p -eq $homePath) {break}; $p=[IO.Path]::GetDirectoryName($p) } }`,
    );
  };
  const runtimePid = () => host.activeRuntimePid(paths.runtimeStatePath);
  const stop = async () => {
    const before = await state();
    if (before.running)
      await run(
        `${connect} if ($task) {try {$task.Stop(0)} catch {if ($_.Exception.GetBaseException().HResult -ne -2147216629) {throw}}}`,
      );
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (!(await state()).running && (await runtimePid()) === undefined) return;
      await wait(500);
    }
    throw new Error(
      `Scheduled task did not stop. No unrelated process was killed. Inspect ${paths.logPath} before retrying.`,
    );
  };
  const start = async () => {
    const before = await state();
    if (!before.installed || !before.enabled)
      throw new Error("Install or enable this background service first.");
    const activePid = await host.activeRuntimePid(join(baseDir, "userdata", "server-runtime.json"));
    if (activePid !== undefined && (!before.running || activePid !== (await runtimePid()))) {
      throw new Error(
        `Another server owns ${baseDir} (pid ${activePid}). Stop it through its desktop or terminal before starting the service.`,
      );
    }
    if (!before.running) await run(`${connect} $null=$task.Run($null)`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const pid = await runtimePid();
      if (
        pid !== undefined &&
        (await state()).running &&
        (await host.probeRuntime(paths.runtimeStatePath, pid, 1_000))
      )
        return;
      await wait(500);
    }
    throw new Error(
      `Background host did not become healthy. Inspect ${paths.logPath}; credentials and projects were retained.`,
    );
  };
  const status = async (): Promise<ServiceStatus> => {
    const current = await state();
    const pid = current.running ? await runtimePid() : undefined;
    return {
      ...paths,
      supported: true,
      platform: "win32",
      installed: current.installed,
      enabled: current.enabled,
      loaded: current.installed,
      processAlive: pid !== undefined,
      ...(pid === undefined ? {} : { pid }),
      responsive:
        pid !== undefined && (await host.probeRuntime(paths.runtimeStatePath, pid, 1_000)),
      current:
        (await host.exists(paths.versionPath)) &&
        isCurrentServiceInstallation(await host.read(paths.versionPath)),
    };
  };
  const mutate = <A>(operation: string, f: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        await privateDirectory();
        const lock = await host.acquireLock(paths.lockPath, {
          timeoutMs: 15_000,
          pollIntervalMs: 50,
          incompleteOwnerStaleMs: 2_000,
        });
        try {
          return await f();
        } finally {
          await lock.release();
        }
      },
      catch: (cause) => new BootServiceError({ operation, cause }),
    });
  return BootService.of({
    status: Effect.tryPromise({
      try: status,
      catch: (cause) => new BootServiceError({ operation: "checking Windows service", cause }),
    }),
    install: (invocation) =>
      mutate("installing Windows service", async () => {
        const packaged = await Effect.runPromise(resolvePackagedDist(input.cliEntryPath, host));
        const previous = await state();
        const activePid = await host.activeRuntimePid(
          join(baseDir, "userdata", "server-runtime.json"),
        );
        if (activePid !== undefined && (!previous.running || activePid !== (await runtimePid())))
          throw new Error(
            `Stop the existing desktop or foreground host (pid ${activePid}) before installing. The environment data will be retained.`,
          );
        const previousDefinition = previous.installed
          ? await run(`${connect} $task.Xml`)
          : undefined;
        const candidate = join(paths.runtimesDir, `${packageJson.version}-${randomUUID()}`);
        await host.makeDirectory(paths.runtimesDir, 0o700);
        const environment = {
          PATH: input.environment.PATH ?? input.environment.Path ?? "",
          T3CODE_HOME: baseDir,
          T3CODE_SERVICE_RUNTIME_STATE_PATH: paths.runtimeStatePath,
          T3CODE_NO_BROWSER: "true",
          T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
          T3CODE_BACKGROUND_SERVICE: "true",
          ...Object.fromEntries(
            [
              "T3CODE_RELAY_URL",
              "T3CODE_CLERK_PUBLISHABLE_KEY",
              "T3CODE_CLERK_JWT_TEMPLATE",
              "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
              "T3CODE_HOSTED_APP_URL",
            ].flatMap((key) =>
              input.environment[key] === undefined ? [] : [[key, input.environment[key]]],
            ),
          ),
        };
        const plan: ServicePlan = {
          ...paths,
          baseDir,
          runtimePath: join(candidate, "bin.mjs"),
          environment,
          arguments: [
            input.executablePath,
            join(candidate, "bin.mjs"),
            "serve",
            "--base-dir",
            baseDir,
            "--host",
            invocation.host ?? "127.0.0.1",
            ...(invocation.port === undefined ? [] : ["--port", String(invocation.port)]),
            invocation.cwd,
          ],
        };
        let activated = false;
        try {
          await host.copyRuntime(packaged.distDir, candidate);
          const check = await host.run(input.executablePath, [plan.runtimePath, "--help"], 15_000);
          if (check.code !== 0 || check.timedOut)
            throw new Error(check.stderr || "Copied CLI failed its startup check.");
          const launcher = join(candidate, "service-launcher.mjs");
          await host.writeAtomic(launcher, renderWindowsLauncher(plan), 0o600);
          const definition = renderWindowsTask({
            sid,
            description,
            executable: input.executablePath,
            launcher,
            cwd: baseDir,
          });
          await stop();
          activated = true;
          await register(definition);
          await host.writeAtomic(paths.definitionPath, definition, 0o600);
          await start();
          await host.writeAtomic(
            paths.versionPath,
            serializeServiceInstallation(invocation),
            0o600,
          );
        } catch (cause) {
          if (activated) {
            try {
              await stop();
              if (previousDefinition !== undefined) {
                await register(previousDefinition);
                await host.writeAtomic(paths.definitionPath, previousDefinition, 0o600);
                if (previous.running) await start();
              } else {
                await run(
                  `${connect} if ($task) {$folder.DeleteTask(${powershellLiteral(label)},0)}`,
                );
                await host.remove(paths.definitionPath);
              }
            } catch (rollback) {
              throw new AggregateError(
                [cause, rollback],
                "Windows host update failed and rollback was incomplete; runtime snapshots were retained for recovery.",
                { cause },
              );
            }
          }
          await host.remove(candidate, true);
          throw cause;
        }
        for (const entry of await host.listDirectory(paths.runtimesDir)) {
          if (join(paths.runtimesDir, entry) !== candidate)
            await host.remove(join(paths.runtimesDir, entry), true);
        }
        return plan;
      }),
    start: mutate("starting Windows service", start),
    restart: mutate("restarting Windows service", async () => {
      await stop();
      await start();
    }),
    stop: mutate("stopping Windows service", stop),
    enable: mutate("enabling Windows service", async () => {
      await run(
        `${connect} if (-not $task) {throw 'Service is not installed'}; $task.Enabled=$true`,
      );
      await start();
    }),
    disable: mutate("disabling Windows service", async () => {
      await run(`${connect} if ($task) {$task.Enabled=$false}`);
      await stop();
    }),
    uninstall: mutate("uninstalling Windows service", async () => {
      const before = await state();
      await stop();
      await run(`${connect} if ($task) {$folder.DeleteTask(${powershellLiteral(label)},0)}`);
      await host.remove(paths.instanceDir, true);
      return before.installed;
    }),
  });
}
