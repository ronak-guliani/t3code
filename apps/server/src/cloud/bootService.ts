import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import packageJson from "../../package.json" with { type: "json" };

export const SERVICE_LABEL = "com.t3tools.t3code.server";
export const SYSTEMD_UNIT = "t3code.service";
const SERVICE_ENV_KEYS = [
  "PATH",
  "T3CODE_RELAY_URL",
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_LOG_LEVEL",
] as const;

export interface ServiceInvocation {
  readonly baseDir: string;
  readonly cwd: string;
  readonly host?: string;
  readonly port?: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ServicePlan {
  readonly platform: "darwin" | "linux";
  readonly definitionPath: string;
  readonly logPath: string;
  readonly runtimePath: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ServiceStatus {
  readonly supported: boolean;
  readonly platform: NodeJS.Platform;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly current: boolean;
  readonly definitionPath: string;
  readonly logPath: string;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background services support macOS launchd and Linux systemd; '${this.platform}' is unsupported.`;
  }
}

export class BootServiceError extends Schema.TaggedErrorClass<BootServiceError>()(
  "BootServiceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Background service operation failed while ${this.operation}.`;
  }
}

export interface ServiceHost {
  readonly exists: (path: string) => Promise<boolean>;
  readonly read: (path: string) => Promise<string>;
  readonly writeAtomic: (path: string, contents: string, mode: number) => Promise<void>;
  readonly copyRuntimeAtomic: (
    sourceDirectory: string,
    destinationDirectory: string,
  ) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => Promise<ProcessRunResult>;
}

export const liveServiceHost: ServiceHost = {
  exists: async (path) =>
    access(path, constants.F_OK).then(
      () => true,
      () => false,
    ),
  read: (path) => readFile(path, "utf8"),
  writeAtomic: async (path, contents, mode) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode });
    await rename(temporary, path);
  },
  copyRuntimeAtomic: async (sourceDirectory, destinationDirectory) => {
    await mkdir(dirname(destinationDirectory), { recursive: true });
    const temporary = `${destinationDirectory}.${process.pid}.tmp`;
    await rm(temporary, { force: true, recursive: true });
    await cp(sourceDirectory, temporary, { recursive: true, force: true });
    await rm(destinationDirectory, { force: true, recursive: true });
    await rename(temporary, destinationDirectory);
  },
  remove: (path) => rm(path, { force: true }),
  run: (command, args, timeoutMs) =>
    runProcess(command, args, {
      allowNonZeroExit: true,
      timeoutMs: timeoutMs ?? 15_000,
      outputMode: "truncate",
      maxBufferBytes: 256 * 1024,
    }),
};

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const systemdQuote = (value: string) =>
  `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function renderLaunchAgent(plan: ServicePlan): string {
  const strings = (values: ReadonlyArray<string>) =>
    values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const environment = Object.entries(plan.environment)
    .flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${SERVICE_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    strings(plan.arguments),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environment,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(plan.environment.T3CODE_SERVICE_CWD ?? homedir())}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(plan.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(plan.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function renderSystemdUnit(plan: ServicePlan): string {
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(plan.environment.T3CODE_SERVICE_CWD ?? homedir())}`,
    ...Object.entries(plan.environment).map(
      ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
    ),
    `ExecStart=${plan.arguments.map(systemdQuote).join(" ")}`,
    "KillMode=control-group",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${plan.logPath.replaceAll("%", "%%")}`,
    `StandardError=append:${plan.logPath.replaceAll("%", "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (
      invocation: ServiceInvocation,
    ) => Effect.Effect<ServicePlan, BootServiceError | BootServiceUnsupportedError>;
    readonly status: Effect.Effect<ServiceStatus, BootServiceError>;
    readonly start: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly restart: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly stop: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly enable: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly disable: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError | BootServiceUnsupportedError>;
  }
>()("t3/cloud/BootService") {}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BootServiceError({ operation, cause }),
  });

export const make = Effect.fn("cloud.bootService.make")(function* (input?: {
  readonly host?: ServiceHost;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly userId?: number | null;
  readonly executablePath?: string;
  readonly cliEntryPath?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
}) {
  const host = input?.host ?? liveServiceHost;
  const platform = input?.platform ?? (yield* HostProcessPlatform);
  const executablePath = input?.executablePath ?? (yield* HostProcessExecutablePath);
  const processArguments = yield* HostProcessArguments;
  const cliEntryPath = resolve(input?.cliEntryPath ?? processArguments[1] ?? "");
  const processEnvironment = input?.processEnvironment ?? (yield* HostProcessEnvironment);
  const userId = input?.userId ?? (yield* HostProcessUserId);
  const homeDir = input?.homeDir ?? homedir();
  const baseRuntimeDir = join(homeDir, ".t3", "runtime", "background-service");
  const runtimeDirectory = join(baseRuntimeDir, "dist");
  const runtimePath = join(runtimeDirectory, "bin.mjs");
  const versionPath = join(baseRuntimeDir, "version");
  const launchDefinition = join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const systemdDefinition = join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
  const definitionPath = platform === "darwin" ? launchDefinition : systemdDefinition;
  const logPath = join(baseRuntimeDir, "service.log");
  const launchTarget = userId === null ? null : `gui/${userId}/${SERVICE_LABEL}`;

  const requireSupported = Effect.gen(function* () {
    if (
      (platform !== "darwin" && platform !== "linux") ||
      (platform === "darwin" && launchTarget === null)
    ) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });
  const runChecked = (operation: string, command: string, args: ReadonlyArray<string>) =>
    attempt(operation, () => host.run(command, args)).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result)
          : Effect.fail(new BootServiceError({ operation, cause: result.stderr || result.stdout })),
      ),
    );
  const isRunning = attempt("checking service state", async () => {
    if (platform === "darwin") {
      if (launchTarget === null) return false;
      return (await host.run("/bin/launchctl", ["print", launchTarget])).code === 0;
    }
    if (platform === "linux") {
      return (
        (await host.run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT])).code === 0
      );
    }
    return false;
  });
  const isEnabled = attempt("checking service enablement", async () => {
    if (platform === "darwin") {
      if (userId === null) return false;
      const disabled = await host.run("/bin/launchctl", ["print-disabled", `gui/${userId}`]);
      return (
        disabled.code === 0 &&
        !disabled.stdout
          .split("\n")
          .some((line) => line.includes(SERVICE_LABEL) && line.includes("=> true"))
      );
    }
    if (platform === "linux") {
      return (
        (await host.run("systemctl", ["--user", "is-enabled", "--quiet", SYSTEMD_UNIT])).code === 0
      );
    }
    return false;
  });
  const control = (action: "start" | "restart" | "stop") =>
    Effect.gen(function* () {
      yield* requireSupported;
      if (platform === "darwin") {
        if (launchTarget === null) return;
        if (action === "stop") {
          if (yield* isRunning) {
            yield* runChecked("stopping launchd service", "/bin/launchctl", [
              "bootout",
              launchTarget,
            ]);
          }
          return;
        }
        if (!(yield* isRunning)) {
          yield* runChecked("loading launchd service", "/bin/launchctl", [
            "bootstrap",
            `gui/${userId}`,
            definitionPath,
          ]);
        }
        yield* runChecked(`${action}ing launchd service`, "/bin/launchctl", [
          "kickstart",
          ...(action === "restart" ? ["-k"] : []),
          launchTarget,
        ]);
        return;
      }
      yield* runChecked(`${action}ing systemd service`, "systemctl", [
        "--user",
        action,
        SYSTEMD_UNIT,
      ]);
    });

  const status = Effect.gen(function* () {
    const supported = platform === "darwin" ? launchTarget !== null : platform === "linux";
    const installed = yield* attempt("checking service definition", () =>
      host.exists(definitionPath),
    );
    const [running, enabled] =
      supported && installed
        ? yield* Effect.all([isRunning, isEnabled])
        : ([false, false] as const);
    if (!installed) {
      return {
        supported,
        platform,
        installed,
        enabled,
        running,
        current: false,
        definitionPath,
        logPath,
      };
    }
    const definition = yield* attempt("reading service definition", () =>
      host.read(definitionPath),
    );
    const [runtimeExists, installedVersion] = yield* Effect.all([
      attempt("checking service runtime", () => host.exists(runtimePath)),
      attempt("checking service version", async () =>
        (await host.exists(versionPath)) ? await host.read(versionPath) : "",
      ),
    ]);
    return {
      supported,
      platform,
      installed,
      enabled,
      running,
      current:
        runtimeExists &&
        installedVersion.trim() === packageJson.version &&
        definition.includes(runtimePath),
      definitionPath,
      logPath,
    };
  });

  return BootService.of({
    install: (invocation) =>
      Effect.gen(function* () {
        yield* requireSupported;
        const environment = Object.fromEntries(
          SERVICE_ENV_KEYS.flatMap((key) => {
            const value = processEnvironment[key];
            return value === undefined ? [] : [[key, value]];
          }),
        );
        const arguments_ = [
          executablePath,
          runtimePath,
          "serve",
          "--base-dir",
          invocation.baseDir,
          ...(invocation.host === undefined ? [] : ["--host", invocation.host]),
          ...(invocation.port === undefined ? [] : ["--port", String(invocation.port)]),
          invocation.cwd,
        ];
        const plan: ServicePlan = {
          platform: platform === "darwin" ? "darwin" : "linux",
          definitionPath,
          logPath,
          runtimePath,
          arguments: arguments_,
          environment: {
            ...environment,
            ...invocation.environment,
            T3CODE_HOME: invocation.baseDir,
            T3CODE_NO_BROWSER: "true",
            T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
            T3CODE_SERVICE_CWD: invocation.cwd,
          },
        };
        yield* attempt("copying the packaged CLI", () =>
          host.copyRuntimeAtomic(dirname(cliEntryPath), runtimeDirectory),
        );
        yield* attempt("recording the packaged CLI version", () =>
          host.writeAtomic(versionPath, `${packageJson.version}\n`, 0o600),
        );
        yield* attempt("writing service definition", () =>
          host.writeAtomic(
            definitionPath,
            platform === "darwin" ? renderLaunchAgent(plan) : renderSystemdUnit(plan),
            0o600,
          ),
        );
        if (platform === "darwin") {
          if (yield* isRunning) {
            yield* runChecked("unloading the previous launchd service", "/bin/launchctl", [
              "bootout",
              launchTarget!,
            ]);
          }
          yield* runChecked("enabling launchd service", "/bin/launchctl", [
            "enable",
            launchTarget!,
          ]);
          yield* runChecked("loading launchd service", "/bin/launchctl", [
            "bootstrap",
            `gui/${userId}`,
            definitionPath,
          ]);
          yield* runChecked("starting launchd service", "/bin/launchctl", [
            "kickstart",
            "-k",
            launchTarget!,
          ]);
        } else {
          yield* runChecked("reloading systemd units", "systemctl", ["--user", "daemon-reload"]);
          yield* runChecked("enabling systemd service", "systemctl", [
            "--user",
            "enable",
            SYSTEMD_UNIT,
          ]);
          yield* runChecked("enabling user lingering", "loginctl", ["enable-linger"]);
          yield* runChecked("starting systemd service", "systemctl", [
            "--user",
            "restart",
            SYSTEMD_UNIT,
          ]);
        }
        return plan;
      }),
    status,
    start: control("start"),
    restart: control("restart"),
    stop: control("stop"),
    enable: Effect.gen(function* () {
      yield* requireSupported;
      if (platform === "darwin") {
        yield* runChecked("enabling launchd service", "/bin/launchctl", [
          "enable",
          `gui/${userId}/${SERVICE_LABEL}`,
        ]);
        yield* control("start");
      } else {
        yield* runChecked("enabling systemd service", "systemctl", [
          "--user",
          "enable",
          "--now",
          SYSTEMD_UNIT,
        ]);
      }
    }),
    disable: Effect.gen(function* () {
      yield* requireSupported;
      if (platform === "darwin") {
        if (yield* isRunning) {
          yield* runChecked("stopping launchd service", "/bin/launchctl", [
            "bootout",
            launchTarget!,
          ]);
        }
        yield* runChecked("disabling launchd service", "/bin/launchctl", [
          "disable",
          launchTarget!,
        ]);
      } else {
        yield* runChecked("disabling systemd service", "systemctl", [
          "--user",
          "disable",
          "--now",
          SYSTEMD_UNIT,
        ]);
      }
    }),
    uninstall: Effect.gen(function* () {
      yield* requireSupported;
      const installed = yield* attempt("checking service definition", () =>
        host.exists(definitionPath),
      );
      if (!installed) return false;
      if (platform === "darwin") {
        if (yield* isRunning) {
          yield* runChecked("stopping launchd service", "/bin/launchctl", [
            "bootout",
            launchTarget!,
          ]);
        }
        yield* runChecked("clearing launchd disabled state", "/bin/launchctl", [
          "enable",
          launchTarget!,
        ]);
      } else {
        yield* runChecked("disabling systemd service", "systemctl", [
          "--user",
          "disable",
          "--now",
          SYSTEMD_UNIT,
        ]);
      }
      yield* attempt("removing service definition", () => host.remove(definitionPath));
      if (platform === "linux") {
        yield* runChecked("reloading systemd units", "systemctl", ["--user", "daemon-reload"]);
      }
      return true;
    }),
  });
});

export const layer = Layer.effect(BootService, make());
