import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Schema } from "effect";
import { buildIdentity } from "../buildIdentity.ts";
import { hasCloudCliOAuthConfig, hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { resolveBaseDir } from "../os-jank.ts";

export function installationIdentity() {
  return {
    ...buildIdentity,
    executable: process.execPath,
    entrypoint: resolve(process.argv[1] ?? ""),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

export interface PreflightCheck {
  readonly name: string;
  readonly status: "pass" | "warning" | "fail";
  readonly detail: string;
}

export function supportedNode(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 24 && (minor! > 13 || (minor === 13 && patch! >= 1));
}

async function findExecutable(name: string): Promise<string | null> {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !("code" in cause) ||
          !["ENOENT", "ENOTDIR", "EACCES"].includes(String(cause.code))
        )
          throw cause;
      }
    }
  }
  return null;
}

export async function installationPreflight(input: { baseDir: string; role: "host" | "client" }) {
  const identity = installationIdentity();
  const checks: PreflightCheck[] = [
    {
      name: "node",
      status: supportedNode(identity.node) ? "pass" : "fail",
      detail: `Node ${identity.node}; this distribution requires Node 24.13.1 or newer within Node 24.`,
    },
    {
      name: "architecture",
      status: ["arm64", "x64"].includes(identity.arch) ? "pass" : "fail",
      detail: `${identity.platform}-${identity.arch}`,
    },
    ...(input.role === "host"
      ? [
          {
            name: "background-host",
            status: (identity.platform === "darwin" || identity.platform === "win32"
              ? "pass"
              : "fail") as PreflightCheck["status"],
            detail:
              "Managed hosting supports macOS and Windows. On other systems use serve with an explicitly managed foreground process.",
          },
        ]
      : []),
    {
      name: "connect-config",
      status: (input.role === "host" ? hasCloudPublicConfig : hasCloudCliOAuthConfig)
        ? "pass"
        : "fail",
      detail:
        "Connect public configuration must be embedded in this distribution or explicitly configured.",
    },
  ];
  let ancestor = resolve(input.baseDir);
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory())
        throw new Error("The installation path must have a real directory ancestor.");
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw cause;
      ancestor = parent;
    }
  }
  try {
    const probe = await mkdtemp(join(ancestor, ".t3-write-probe-"));
    await rm(probe, { recursive: true });
    checks.push({ name: "writable-state", status: "pass", detail: resolve(input.baseDir) });
  } catch {
    checks.push({
      name: "writable-state",
      status: "fail",
      detail: "Cannot create private state here. Choose a writable, user-owned local directory.",
    });
  }
  const names = input.role === "host" ? ["git", "pnpm", "codex", "claude", "copilot"] : ["pnpm"];
  const executables = await Promise.all(
    names.map(async (name) => ({ name, path: await findExecutable(name) })),
  );
  for (const item of executables) {
    checks.push({
      name: item.name,
      status: item.path
        ? "pass"
        : input.role === "host" && item.name === "git"
          ? "fail"
          : "warning",
      detail:
        item.path ??
        (item.name === "pnpm"
          ? "Not required for a packaged install; needed only to build from source."
          : "Not on PATH. Install and authenticate providers you intend to use; no provider process was started."),
    });
  }
  const packaged = identity.entrypoint.replaceAll("\\", "/").endsWith("/dist/bin.mjs");
  if (input.role === "host") {
    const require = createRequire(import.meta.url);
    try {
      require("node-pty");
      checks.push({ name: "native-pty", status: "pass", detail: "Native terminal module loads." });
    } catch {
      checks.push({
        name: "native-pty",
        status: "fail",
        detail:
          "Native terminal dependency could not load. Reinstall for this OS/architecture and Node runtime.",
      });
    }
    try {
      if (!packaged) throw new Error("source");
      await access(join(dirname(identity.entrypoint), "client", "index.html"));
      checks.push({
        name: "packaged-client",
        status: "pass",
        detail: "Bundled web client is present.",
      });
    } catch {
      checks.push({
        name: "packaged-client",
        status: "fail",
        detail: "Use this fork's packaged CLI, or run pnpm build before host setup.",
      });
    }
  }
  const proxyConfigured = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
  ].some((key) => Boolean(process.env[key]));
  checks.push({
    name: "proxy",
    status: proxyConfigured ? "warning" : "pass",
    detail: proxyConfigured
      ? "Proxy settings are present (values redacted). Confirm the relay connector can reach HTTPS and that loopback bypass is configured."
      : "No proxy environment override detected.",
  });
  return {
    version: 1 as const,
    identity,
    role: input.role,
    baseDir: resolve(input.baseDir),
    checks,
    ready: checks.every((check) => check.status !== "fail"),
  };
}

const RuntimeOwner = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
  origin: Schema.String,
  startedAt: Schema.String,
  owner: Schema.optional(Schema.Literals(["desktop", "foreground", "background"])),
});
const decodeRuntimeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeOwner));
export async function inspectRuntimeOwnership(baseDir: string) {
  try {
    const runtime = decodeRuntimeOwner(
      await readFile(join(baseDir, "userdata", "server-runtime.json"), "utf8"),
    );
    let alive = true;
    try {
      process.kill(runtime.pid, 0);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") alive = false;
      else throw cause;
    }

    return {
      state: alive ? ("running" as const) : ("stopped" as const),
      owner: runtime.owner ?? "unknown",
      pid: runtime.pid,
    };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { state: "stopped" as const, owner: "none", pid: null };
    throw new Error(
      "Cannot verify runtime ownership. Do not start another server; inspect local runtime state first.",
      { cause },
    );
  }
}

export const installationCommand = Command.make("installation").pipe(
  Command.withDescription(
    "Inspect this executable and check installation prerequisites without signing in.",
  ),
  Command.withSubcommands([
    Command.make("identity", { json: Flag.boolean("json") }).pipe(
      Command.withHandler(({ json }) => {
        const identity = installationIdentity();
        return Console.log(
          json
            ? JSON.stringify(identity)
            : Object.entries(identity)
                .map(([key, value]) => `${key}: ${value ?? "unknown"}`)
                .join("\n"),
        );
      }),
    ),
    Command.make("preflight", {
      baseDir: Flag.string("base-dir").pipe(Flag.optional),
      role: Flag.choice("role", ["host", "client"]).pipe(Flag.withDefault("host")),
      json: Flag.boolean("json"),
    }).pipe(
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const baseDir = yield* resolveBaseDir(
            Option.getOrUndefined(flags.baseDir) ?? process.env.T3CODE_HOME,
          );
          const report = yield* Effect.tryPromise(() =>
            installationPreflight({ baseDir, role: flags.role }),
          );
          yield* Console.log(
            flags.json
              ? JSON.stringify(report)
              : report.checks
                  .map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`)
                  .join("\n"),
          );
          if (!report.ready)
            return yield* Effect.fail(
              new Error("Installation preflight failed. Resolve the failed checks before setup."),
            );
        }),
      ),
    ),
  ]),
);
