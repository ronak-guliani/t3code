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
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { runProcess, type ProcessRunResult } from "../processRunner.ts";

const LABEL_PREFIX = "com.t3tools.t3code.server";
const COMMAND_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 20_000;

export interface ServiceInvocation {
  readonly cwd: string;
  readonly host?: string;
  readonly port?: number;
}

export interface ServicePaths {
  readonly instanceId: string;
  readonly label: string;
  readonly target: string;
  readonly definitionPath: string;
  readonly instanceDir: string;
  readonly runtimesDir: string;
  readonly versionPath: string;
  readonly logPath: string;
  readonly runtimeStatePath: string;
}

export interface ServicePlan extends ServicePaths {
  readonly baseDir: string;
  readonly runtimePath: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ServiceStatus extends ServicePaths {
  readonly supported: boolean;
  readonly platform: NodeJS.Platform;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly processAlive: boolean;
  readonly responsive: boolean;
  readonly pid?: number;
  readonly current: boolean;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background services currently support macOS launchd; '${this.platform}' is unsupported.`;
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

export interface SupervisorState {
  readonly loaded: boolean;
  readonly processAlive: boolean;
  readonly pid?: number;
}

export interface ServiceHost {
  readonly canonicalize: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly read: (path: string) => Promise<string>;
  readonly writeAtomic: (path: string, contents: string, mode: number) => Promise<void>;
  readonly makeDirectory: (path: string, mode: number) => Promise<void>;
  readonly listDirectory: (path: string) => Promise<ReadonlyArray<string>>;
  readonly copyDirectory: (source: string, destination: string) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly remove: (path: string, recursive?: boolean) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => Promise<ProcessRunResult>;
  readonly probeRuntime: (runtimeStatePath: string, timeoutMs: number) => Promise<boolean>;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export const liveServiceHost: ServiceHost = {
  canonicalize: async (path) => {
    const absolute = resolve(path);
    return realpath(absolute).catch(() => absolute);
  },
  exists: async (path) =>
    access(path, constants.F_OK).then(
      () => true,
      () => false,
    ),
  read: (path) => readFile(path, "utf8"),
  writeAtomic: async (path, contents, mode) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode });
    await rename(temporary, path);
    await chmod(path, mode);
  },
  makeDirectory: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
    await chmod(path, mode);
  },
  listDirectory: async (path) => {
    const { readdir } = await import("node:fs/promises");
    return readdir(path);
  },
  copyDirectory: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  },
  rename,
  remove: (path, recursive = false) => rm(path, { force: true, recursive }),
  chmod,
  run: (command, args, timeoutMs) =>
    runProcess(command, args, {
      allowNonZeroExit: true,
      timeoutMs: timeoutMs ?? COMMAND_TIMEOUT_MS,
      outputMode: "truncate",
      maxBufferBytes: 256 * 1024,
    }),
  probeRuntime: async (runtimeStatePath, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = JSON.parse(await readFile(runtimeStatePath, "utf8")) as {
          readonly origin?: unknown;
        };
        if (typeof state.origin === "string") {
          const response = await fetch(state.origin, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) return true;
        }
      } catch {
        // Startup races are expected; retry until the bounded deadline.
      }
      await sleep(100);
    }
    return false;
  },
};

export const serviceInstanceId = (canonicalBaseDir: string): string =>
  createHash("sha256").update(canonicalBaseDir).digest("hex").slice(0, 12);

export function servicePaths(input: {
  readonly homeDir: string;
  readonly canonicalBaseDir: string;
  readonly userId: number;
}): ServicePaths {
  const instanceId = serviceInstanceId(input.canonicalBaseDir);
  const label = `${LABEL_PREFIX}.${instanceId}`;
  const instanceDir = join(input.canonicalBaseDir, "runtime", "background-service", instanceId);
  return {
    instanceId,
    label,
    target: `gui/${input.userId}/${label}`,
    definitionPath: join(input.homeDir, "Library", "LaunchAgents", `${label}.plist`),
    instanceDir,
    runtimesDir: join(instanceDir, "runtimes"),
    versionPath: join(instanceDir, "version"),
    logPath: join(instanceDir, "service.log"),
    runtimeStatePath: join(input.canonicalBaseDir, "userdata", "server-runtime.json"),
  };
}

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function renderLaunchAgent(plan: ServicePlan): string {
  const argumentsXml = plan.arguments
    .map((value) => `    <string>${xml(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(plan.environment)
    .flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${plan.label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsXml,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentXml,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(plan.environment.T3CODE_SERVICE_CWD ?? homedir())}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(plan.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(plan.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function parseLaunchctlState(output: string): SupervisorState {
  const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(output);
  const pid = pidMatch === null ? undefined : Number(pidMatch[1]);
  const stateMatch = /^\s*state\s*=\s*(\S+)\s*$/m.exec(output);
  return {
    loaded: true,
    processAlive: pid !== undefined && stateMatch?.[1] === "running",
    ...(pid === undefined ? {} : { pid }),
  };
}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BootServiceError({ operation, cause }),
  });

export const resolvePackagedDist = (entryPath: string, host: ServiceHost) =>
  attempt("resolving the packaged CLI", async () => {
    const resolvedEntry = await host.canonicalize(entryPath);
    if (resolvedEntry.includes("/_npx/") || resolvedEntry.includes("/.bun/install/cache/")) {
      throw new Error("Transient package-manager cache entrypoints cannot own a durable service.");
    }
    if (!resolvedEntry.endsWith("/dist/bin.mjs")) {
      throw new Error(`Expected a packaged dist/bin.mjs entrypoint, received ${resolvedEntry}.`);
    }
    const distDir = dirname(resolvedEntry);
    const entries = await Promise.all([
      host.exists(resolvedEntry),
      host.exists(join(distDir, "client", "index.html")),
    ]);
    if (!entries.every(Boolean)) {
      throw new Error("The packaged CLI is missing dist/bin.mjs or dist/client/index.html.");
    }
    return { entryPath: resolvedEntry, distDir };
  });

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

export const make = Effect.fn("cloud.bootService.make")(function* (input: {
  readonly baseDir: string;
  readonly host?: ServiceHost;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly userId?: number | null;
  readonly executablePath?: string;
  readonly cliEntryPath?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
}) {
  const host = input.host ?? liveServiceHost;
  const platform = input.platform ?? (yield* HostProcessPlatform);
  const executablePath = input.executablePath ?? (yield* HostProcessExecutablePath);
  const processArguments = yield* HostProcessArguments;
  const cliEntryPath = input.cliEntryPath ?? processArguments[1] ?? "";
  const processEnvironment = input.processEnvironment ?? (yield* HostProcessEnvironment);
  const hostUserId = yield* HostProcessUserId;
  const userId = input.userId === undefined ? hostUserId : input.userId;
  const homeDir = input.homeDir ?? homedir();
  const canonicalBaseDir = yield* attempt("canonicalizing the base directory", () =>
    host.canonicalize(input.baseDir),
  );
  const paths = userId === null ? null : servicePaths({ homeDir, canonicalBaseDir, userId });

  const requireSupported = Effect.gen(function* () {
    if (platform !== "darwin" || paths === null) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });
  const runChecked = (
    operation: string,
    args: ReadonlyArray<string>,
    acceptableCodes: ReadonlyArray<number> = [0],
  ) =>
    attempt(operation, () => host.run("/bin/launchctl", args, COMMAND_TIMEOUT_MS)).pipe(
      Effect.flatMap((result) =>
        result.code !== null && acceptableCodes.includes(result.code)
          ? Effect.succeed(result)
          : Effect.fail(new BootServiceError({ operation, cause: result.stderr || result.stdout })),
      ),
    );
  const supervisorState = Effect.gen(function* () {
    if (paths === null) return { loaded: false, processAlive: false } satisfies SupervisorState;
    const result = yield* attempt("checking launchd state", () =>
      host.run("/bin/launchctl", ["print", paths.target], COMMAND_TIMEOUT_MS),
    );
    return result.code === 0
      ? parseLaunchctlState(result.stdout)
      : ({ loaded: false, processAlive: false } satisfies SupervisorState);
  });
  const enabled = Effect.gen(function* () {
    if (paths === null || userId === null) return false;
    const result = yield* attempt("checking launchd enablement", () =>
      host.run("/bin/launchctl", ["print-disabled", `gui/${userId}`], COMMAND_TIMEOUT_MS),
    );
    return (
      result.code === 0 &&
      !result.stdout
        .split("\n")
        .some((line) => line.includes(paths.label) && line.includes("=> true"))
    );
  });
  const stopLoaded = Effect.gen(function* () {
    if (paths === null) return;
    yield* runChecked("stopping launchd service", ["bootout", paths.target], [0, 3, 113]);
  });
  const startAndProbe = Effect.gen(function* () {
    if (paths === null || userId === null) return;
    yield* attempt("clearing stale runtime state", () => host.remove(paths.runtimeStatePath));
    const current = yield* supervisorState;
    if (!current.loaded) {
      yield* runChecked("loading launchd service", [
        "bootstrap",
        `gui/${userId}`,
        paths.definitionPath,
      ]);
    }
    yield* runChecked("starting launchd service", ["kickstart", "-k", paths.target]);
    const responsive = yield* attempt("waiting for the server health probe", () =>
      host.probeRuntime(paths.runtimeStatePath, HEALTH_TIMEOUT_MS),
    );
    if (!responsive) {
      const state = yield* supervisorState;
      return yield* new BootServiceError({
        operation: "waiting for the background server to become responsive",
        cause: state.processAlive
          ? "The process is alive but its HTTP endpoint did not become responsive."
          : "launchd loaded the job but no server process remained alive.",
      });
    }
  });

  const status = Effect.gen(function* () {
    const fallbackPaths = paths ?? servicePaths({ homeDir, canonicalBaseDir, userId: userId ?? 0 });
    const [installed, versionExists] = yield* Effect.all(
      [
        attempt("checking service definition", () => host.exists(fallbackPaths.definitionPath)),
        attempt("checking service version", () => host.exists(fallbackPaths.versionPath)),
      ],
      { concurrency: "unbounded" },
    );
    const state =
      platform === "darwin" && paths !== null
        ? yield* supervisorState
        : ({ loaded: false, processAlive: false } satisfies SupervisorState);
    const responsive =
      state.processAlive &&
      (yield* attempt("probing the background server", () =>
        host.probeRuntime(fallbackPaths.runtimeStatePath, 1_000),
      ));
    const [installedVersion, definition] = yield* Effect.all(
      [
        versionExists
          ? attempt("reading service version", () => host.read(fallbackPaths.versionPath))
          : Effect.succeed(""),
        installed
          ? attempt("reading service definition", () => host.read(fallbackPaths.definitionPath))
          : Effect.succeed(""),
      ],
      { concurrency: "unbounded" },
    );
    return {
      ...fallbackPaths,
      supported: platform === "darwin" && paths !== null,
      platform,
      installed,
      enabled: platform === "darwin" && paths !== null ? yield* enabled : false,
      loaded: state.loaded,
      processAlive: state.processAlive,
      responsive,
      ...(state.pid === undefined ? {} : { pid: state.pid }),
      current:
        installedVersion.trim() === packageJson.version &&
        definition.includes(fallbackPaths.instanceId),
    } satisfies ServiceStatus;
  });

  return BootService.of({
    install: (invocation) =>
      Effect.gen(function* () {
        yield* requireSupported;
        const activePaths = paths!;
        const packaged = yield* resolvePackagedDist(cliEntryPath, host);
        const candidateDir = join(
          activePaths.runtimesDir,
          `${packageJson.version}-${Date.now().toString(36)}`,
        );
        const candidateRuntime = join(candidateDir, "bin.mjs");
        const previousDefinitionExists = yield* attempt(
          "checking previous service definition",
          () => host.exists(activePaths.definitionPath),
        );
        const previousDefinition = previousDefinitionExists
          ? yield* attempt("reading previous service definition", () =>
              host.read(activePaths.definitionPath),
            )
          : undefined;
        const previousState = yield* supervisorState;
        const previouslyEnabled = yield* enabled;
        yield* attempt("creating private service directories", async () => {
          await host.makeDirectory(activePaths.instanceDir, 0o700);
          await host.makeDirectory(activePaths.runtimesDir, 0o700);
          if (!(await host.exists(activePaths.logPath))) {
            await host.writeAtomic(activePaths.logPath, "", 0o600);
          } else {
            await host.chmod(activePaths.logPath, 0o600);
          }
        });
        const copied = yield* attempt("copying the packaged runtime", () =>
          host.copyDirectory(packaged.distDir, candidateDir),
        ).pipe(Effect.exit);
        if (copied._tag === "Failure") {
          yield* attempt("removing partial runtime candidate", () =>
            host.remove(candidateDir, true),
          ).pipe(Effect.ignore);
          return yield* Effect.failCause(copied.cause);
        }
        yield* attempt("securing the packaged runtime", () => host.chmod(candidateDir, 0o700));
        const environment = {
          PATH: processEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          T3CODE_HOME: canonicalBaseDir,
          T3CODE_NO_BROWSER: "true",
          T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
          T3CODE_BACKGROUND_SERVICE: "true",
          T3CODE_SERVICE_CWD: resolve(invocation.cwd),
        };
        const plan: ServicePlan = {
          ...activePaths,
          baseDir: canonicalBaseDir,
          runtimePath: candidateRuntime,
          arguments: [
            executablePath,
            candidateRuntime,
            "serve",
            "--base-dir",
            canonicalBaseDir,
            ...(invocation.host === undefined ? [] : ["--host", invocation.host]),
            ...(invocation.port === undefined ? [] : ["--port", String(invocation.port)]),
            resolve(invocation.cwd),
          ],
          environment,
        };
        const definition = renderLaunchAgent(plan);
        const commit = Effect.gen(function* () {
          yield* attempt("writing the launchd definition", () =>
            host.writeAtomic(activePaths.definitionPath, definition, 0o600),
          );
          yield* runChecked("enabling launchd service", ["enable", activePaths.target]);
          yield* stopLoaded;
          yield* startAndProbe;
          yield* attempt("recording the active service version", () =>
            host.writeAtomic(activePaths.versionPath, `${packageJson.version}\n`, 0o600),
          );
          yield* attempt("securing the service log", async () => {
            if (await host.exists(activePaths.logPath))
              await host.chmod(activePaths.logPath, 0o600);
          });
        });
        const committed = yield* commit.pipe(Effect.exit);
        if (committed._tag === "Failure") {
          yield* stopLoaded.pipe(Effect.ignore);
          yield* attempt("removing failed runtime candidate", () =>
            host.remove(candidateDir, true),
          ).pipe(Effect.ignore);
          if (previousDefinition === undefined) {
            yield* attempt("removing failed service definition", () =>
              host.remove(activePaths.definitionPath),
            ).pipe(Effect.ignore);
          } else {
            yield* attempt("restoring the previous service definition", () =>
              host.writeAtomic(activePaths.definitionPath, previousDefinition, 0o600),
            ).pipe(Effect.ignore);
            yield* runChecked(
              "restoring launchd enablement",
              [previouslyEnabled ? "enable" : "disable", activePaths.target],
              [0, 3, 113],
            ).pipe(Effect.ignore);
            if (previousState.loaded) {
              yield* startAndProbe.pipe(Effect.ignore);
            }
          }
          return yield* Effect.failCause(committed.cause);
        }
        yield* attempt("pruning inactive service runtimes", async () => {
          const entries = await host.listDirectory(activePaths.runtimesDir);
          await Promise.all(
            entries
              .filter((entry) => join(activePaths.runtimesDir, entry) !== candidateDir)
              .map((entry) => host.remove(join(activePaths.runtimesDir, entry), true)),
          );
        });
        return plan;
      }),
    status,
    start: requireSupported.pipe(Effect.andThen(startAndProbe)),
    restart: requireSupported.pipe(Effect.andThen(stopLoaded), Effect.andThen(startAndProbe)),
    stop: requireSupported.pipe(Effect.andThen(stopLoaded)),
    enable: Effect.gen(function* () {
      yield* requireSupported;
      yield* runChecked("enabling launchd service", ["enable", paths!.target]);
      yield* startAndProbe;
    }),
    disable: Effect.gen(function* () {
      yield* requireSupported;
      yield* stopLoaded;
      yield* runChecked("disabling launchd service", ["disable", paths!.target]);
    }),
    uninstall: Effect.gen(function* () {
      yield* requireSupported;
      const activePaths = paths!;
      const owned = yield* Effect.all([
        attempt("checking launchd definition", () => host.exists(activePaths.definitionPath)),
        attempt("checking service artifacts", () => host.exists(activePaths.instanceDir)),
      ]);
      yield* stopLoaded;
      yield* runChecked("disabling launchd service", ["disable", activePaths.target], [0, 3, 113]);
      yield* attempt("removing launchd definition", () => host.remove(activePaths.definitionPath));
      yield* attempt("removing service artifacts", () =>
        host.remove(activePaths.instanceDir, true),
      );
      yield* attempt("removing stale runtime state", () =>
        host.remove(activePaths.runtimeStatePath),
      );
      return owned.some(Boolean);
    }),
  });
});

export const layer = (baseDir: string) => Layer.effect(BootService, make({ baseDir }));
