import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { resolve } from "node:path";

import * as BootService from "../cloud/bootService.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { inspectRuntimeOwnership, installationIdentity } from "./installation.ts";
import { readFile } from "node:fs/promises";
import { decodeServiceInstallation } from "../cloud/serviceInstallation.ts";

const baseDir = Flag.string("base-dir").pipe(Flag.optional);
const cwd = Flag.string("cwd").pipe(Flag.optional);
const host = Flag.string("host").pipe(Flag.optional);
const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const decodePort = Schema.decodeUnknownEffect(PortSchema);
const port = Flag.integer("port").pipe(Flag.withSchema(PortSchema), Flag.optional);
const lifecycleFlags = { baseDir, cwd, host, port };

const withService = <A, E, R>(
  baseDirValue: string,
  effect: Effect.Effect<A, E, BootService.BootService | R>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.effect(BootService.BootService, BootService.make({ baseDir: baseDirValue })),
    ),
  );

const resolveServiceBaseDir = (value: Option.Option<string>) =>
  resolveBaseDir(Option.getOrUndefined(value) ?? process.env.T3CODE_HOME);

const readInstalledInvocation = (status: BootService.ServiceStatus) =>
  Effect.tryPromise({
    try: async () => {
      if (!status.installed) throw new Error("No service is installed. Use service install first.");
      try {
        return decodeServiceInstallation(await readFile(status.versionPath, "utf8")).invocation;
      } catch (cause) {
        throw new Error(
          "This older service has no saved startup settings. Use service install with its existing --cwd, --host and --port once; subsequent updates preserve them.",
          { cause },
        );
      }
    },
    catch: (cause) =>
      new BootService.BootServiceError({ operation: "reading saved startup settings", cause }),
  });

const install = (name: "install" | "update") =>
  Command.make(name, lifecycleFlags).pipe(
    Command.withDescription("Install or repair the per-user background service and start it."),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
        return yield* withService(
          resolvedBaseDir,
          Effect.gen(function* () {
            const service = yield* BootService.BootService;
            const previous =
              name === "update" ? yield* readInstalledInvocation(yield* service.status) : undefined;
            const hostValue = Option.getOrUndefined(flags.host) ?? previous?.host;
            const portValue = Option.getOrUndefined(flags.port) ?? previous?.port;
            const plan = yield* service.install({
              cwd: resolve(Option.getOrElse(flags.cwd, () => previous?.cwd ?? process.cwd())),
              ...(hostValue === undefined ? {} : { host: hostValue }),
              ...(portValue === undefined ? {} : { port: portValue }),
            });
            yield* Console.log(
              `Background service installed and running.\nDefinition: ${plan.definitionPath}\nLogs: ${plan.logPath}`,
            );
          }),
        );
      }),
    ),
  );

const action = (name: "start" | "restart" | "stop") =>
  Command.make(name, { baseDir }).pipe(
    Command.withDescription(`${name[0]!.toUpperCase()}${name.slice(1)} the background service.`),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
        return yield* withService(
          resolvedBaseDir,
          Effect.gen(function* () {
            const service = yield* BootService.BootService;
            yield* service[name];
            yield* Console.log(`Background service ${name === "stop" ? "stopped" : `${name}ed`}.`);
          }),
        );
      }),
    ),
  );

const enable = Command.make("enable", { baseDir }).pipe(
  Command.withDescription("Enable startup persistence and start the background service."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* service.enable;
          yield* Console.log("Background service enabled and running.");
        }),
      );
    }),
  ),
);

const disable = Command.make("disable", { baseDir }).pipe(
  Command.withDescription("Stop the service and disable automatic startup without removing it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* service.disable;
          yield* Console.log("Background service stopped and disabled.");
        }),
      );
    }),
  ),
);

export function formatServiceStatus(status: BootService.ServiceStatus): string {
  if (!status.supported) {
    return `T3 Code background service\n  Status: unsupported on ${status.platform}\n  Supported: macOS launchd and Windows Task Scheduler`;
  }
  return [
    "T3 Code background service",
    `  Installed: ${status.installed ? "yes" : "no"}`,
    `  Enabled: ${status.enabled ? "yes" : "no"}`,
    `  Loaded: ${status.loaded ? "yes" : "no"}`,
    `  Process: ${status.processAlive ? `running${status.pid === undefined ? "" : ` (pid ${status.pid})`}` : "not running"}`,
    `  Responsive: ${status.responsive ? "yes" : "no"}`,
    `  Current: ${status.current ? "yes" : "no"}`,
    `  Definition: ${status.definitionPath}`,
    `  Logs: ${status.logPath}`,
  ].join("\n");
}

export const restartHealthyCurrentService = (
  service: {
    readonly restart: Effect.Effect<
      void,
      BootService.BootServiceError | BootService.BootServiceUnsupportedError
    >;
  },
  status: BootService.ServiceStatus,
  restartRequired = false,
) => {
  if (
    status.installed &&
    status.enabled &&
    status.current &&
    status.processAlive &&
    status.responsive
  ) {
    return restartRequired ? service.restart.pipe(Effect.as(true)) : Effect.succeed(true);
  }
  return Effect.succeed(false);
};

const installPreservingServiceSettings = (
  status: BootService.ServiceStatus,
  input?: { readonly cwd?: string },
) =>
  Effect.gen(function* () {
    const service = yield* BootService.BootService;
    const previous = status.installed ? yield* readInstalledInvocation(status) : undefined;
    const hostValue = process.env.T3CODE_HOST ?? previous?.host;
    const portValue =
      process.env.T3CODE_PORT === undefined
        ? previous?.port
        : yield* decodePort(Number(process.env.T3CODE_PORT));
    yield* service.install({
      cwd: resolve(input?.cwd ?? previous?.cwd ?? process.cwd()),
      ...(hostValue === undefined ? {} : { host: hostValue }),
      ...(portValue === undefined ? {} : { port: portValue }),
    });
  });

export const ensureBackgroundService = (input?: {
  readonly cwd?: string;
  readonly restartRequired?: boolean;
}) =>
  Effect.gen(function* () {
    const service = yield* BootService.BootService;
    const status = yield* service.status;
    if (!status.supported) {
      return yield* new BootService.BootServiceUnsupportedError({ platform: status.platform });
    }
    if (
      status.installed &&
      status.enabled &&
      status.current &&
      status.processAlive &&
      status.responsive
    ) {
      if (input?.restartRequired) {
        yield* service.restart;
        return "restarted" as const;
      }
      return "ready" as const;
    }
    if (status.installed && status.current && status.processAlive) {
      yield* service.restart;
      return "restarted" as const;
    }
    yield* installPreservingServiceSettings(status, input);
    return status.installed ? ("repaired" as const) : ("installed" as const);
  });

export const ensureBackgroundServiceForBaseDir = (
  baseDirValue: string,
  input?: { readonly cwd?: string; readonly restartRequired?: boolean },
) => withService(baseDirValue, ensureBackgroundService(input));

const status = Command.make("status", { baseDir, json: Flag.boolean("json") }).pipe(
  Command.withDescription("Show installed, enabled, process, health, and version state."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          const status = yield* service.status;
          const runtime = yield* Effect.tryPromise(() => inspectRuntimeOwnership(resolvedBaseDir));
          yield* Console.log(
            flags.json
              ? JSON.stringify({ ...status, runtime })
              : `${formatServiceStatus(status)}\n  Runtime owner: ${runtime.owner} (${runtime.state})`,
          );
        }),
      );
    }),
  ),
);

const uninstall = Command.make("uninstall", { baseDir }).pipe(
  Command.withDescription("Stop, disable, and remove the background service."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* Console.log(
            (yield* service.uninstall)
              ? "Background service removed."
              : "Background service is not installed.",
          );
        }),
      );
    }),
  ),
);

const handoff = Command.make("handoff", {
  baseDir,
  to: Flag.choice("to", ["foreground", "desktop"]),
}).pipe(
  Command.withDescription(
    "Stop and disable the managed host before explicitly starting a different owner.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveServiceBaseDir(flags.baseDir);
      yield* withService(
        baseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* service.disable;
          const runtime = yield* Effect.tryPromise(() => inspectRuntimeOwnership(baseDir));
          if (runtime.state === "running")
            return yield* Effect.fail(
              new Error(
                `A ${runtime.owner} process still owns this environment (pid ${runtime.pid}). Stop it through its own application; no takeover was performed.`,
              ),
            );
          const identity = installationIdentity();
          const quote = (value: string) =>
            process.platform === "win32"
              ? `'${value.replaceAll("'", "''")}'`
              : `'${value.replaceAll("'", "'\\''")}'`;
          const command = [identity.executable, identity.entrypoint, "serve", "--base-dir", baseDir]
            .map(quote)
            .join(" ");
          yield* Console.log(
            flags.to === "desktop"
              ? `Background startup is disabled. Select ${baseDir} in desktop's local environment settings and restart desktop. No databases were moved or merged.`
              : `Background startup is disabled. Start the foreground owner with:\n${process.platform === "win32" ? "& " : ""}${command}`,
          );
        }),
      );
    }),
  ),
);

export const offerServiceDuringOnboarding = (input?: {
  readonly baseDir?: string;
  readonly cwd?: string;
  readonly restartRequired?: boolean;
}) =>
  Effect.gen(function* () {
    const service = yield* BootService.BootService;
    const status = yield* service.status;
    if (!status.supported) return false;
    if (yield* restartHealthyCurrentService(service, status, input?.restartRequired)) return true;
    if (status.installed && status.current) {
      yield* service.enable;
      return true;
    }
    const accepted = yield* Prompt.run(
      Prompt.confirm({
        message: "Keep T3 reachable in the background after this terminal closes?",
        initial: true,
      }),
    );
    if (!accepted) return false;
    yield* installPreservingServiceSettings(status, input);
    return true;
  });

export const recoverServiceOnboardingOffer = <R>(offer: Effect.Effect<boolean, unknown, R>) =>
  offer.pipe(
    Effect.catch((error: unknown) =>
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "QuitError"
        ? Effect.succeed(false)
        : Console.warn(
            `T3 Connect authorization is saved, but background setup did not finish: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).pipe(Effect.as(false)),
    ),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the durable T3 Code background service."),
  Command.withSubcommands([
    install("install"),
    install("update"),
    enable,
    action("start"),
    action("restart"),
    action("stop"),
    disable,
    status,
    uninstall,
    handoff,
  ]),
);
