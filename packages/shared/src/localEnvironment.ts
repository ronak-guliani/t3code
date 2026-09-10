import { readFile, realpath, stat, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

const Selection = Schema.Struct({
  version: Schema.Literal(1),
  baseDir: Schema.String,
  environmentId: Schema.String,
});
const Runtime = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
});
const decodeSelection = Schema.decodeUnknownSync(Schema.fromJsonString(Selection));
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(Runtime));
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
export interface LocalEnvironment {
  readonly baseDir: string;
  readonly environmentId: string;
  readonly label: string;
  readonly status: "online" | "offline" | "unavailable";
  readonly origin: string | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly serverVersion: string | null;
  readonly error: string | null;
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export function localSelectionPath(home = homedir()): string {
  return join(home, ".config", "t3", "local-environment.json");
}

export async function readLocalEnvironmentSelection(home = homedir()) {
  const text = await optionalText(localSelectionPath(home));
  if (text === null) return null;
  const selected = decodeSelection(text);
  if (!isAbsolute(selected.baseDir))
    throw new Error("The selected environment path is not absolute.");
  const id = await optionalText(join(selected.baseDir, "userdata", "environment-id"));
  if (id !== selected.environmentId) {
    throw new Error(
      "The default local environment is missing or its identity changed. Select it again; no fallback was used.",
    );
  }
  return selected;
}

export async function selectLocalEnvironment(baseDir: string, home = homedir()): Promise<void> {
  const canonical = await realpath(baseDir);
  const environmentId = await optionalText(join(canonical, "userdata", "environment-id"));
  if (!environmentId)
    throw new Error("Select an existing T3 environment data directory, not a project directory.");
  const path = localSelectionPath(home);
  await mkdir(join(home, ".config", "t3"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, baseDir: canonical, environmentId }), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

export async function inspectLocalEnvironment(
  baseDir: string,
  stateDirectory: "userdata" | "dev" = "userdata",
): Promise<LocalEnvironment | null> {
  const environmentId = await optionalText(join(baseDir, stateDirectory, "environment-id"));
  if (!environmentId) return null;
  const canonical = await realpath(baseDir);
  const label =
    (await optionalText(join(canonical, stateDirectory, "environment-label"))) || canonical;
  const base: LocalEnvironment = {
    baseDir: canonical,
    environmentId,
    label,
    status: "offline",
    origin: null,
    pid: null,
    startedAt: null,
    serverVersion: null,
    error: null,
  };
  try {
    const text = await optionalText(join(canonical, stateDirectory, "server-runtime.json"));
    if (text === null) return base;
    const runtime = decodeRuntime(text);
    if (runtime.pid <= 0) throw new Error("Invalid environment process ID.");
    try {
      process.kill(runtime.pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return base;
      throw error;
    }

    const url = new URL(runtime.origin);
    if (
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.origin !== runtime.origin
    ) {
      throw new Error("Local discovery requires an exact loopback HTTP origin.");
    }
    const response = await fetch(`${url.origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Environment probe returned HTTP ${response.status}.`);
    const descriptor = decodeDescriptor(await response.json());
    if (descriptor.environmentId !== environmentId)
      throw new Error("The local endpoint belongs to a different environment.");
    return {
      ...base,
      label: descriptor.label,
      status: "online",
      origin: url.origin,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      serverVersion: descriptor.serverVersion,
    };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      error: error instanceof Error ? error.message : "Environment inspection failed.",
    };
  }
}

export async function resolveDefaultLocalBaseDir(home = homedir()): Promise<string> {
  const selection = await readLocalEnvironmentSelection(home);
  if (selection) return selection.baseDir;
  const legacy = join(home, ".t3");
  if (await optionalText(join(legacy, "userdata", "environment-id"))) return legacy;
  for (const name of [".t3-rg", ".t3-alpha"]) {
    const candidate = join(home, name);
    if (await optionalText(join(candidate, "userdata", "environment-id"))) {
      throw new Error(
        `An existing local environment was found at ${candidate}. Run 't3 local list' and 't3 local select --base-dir <directory>' before creating another, or pass an explicit --base-dir to keep them separate.`,
      );
    }
  }
  return legacy;
}

export async function discoverLocalEnvironments(
  extra: readonly string[] = [],
  home = homedir(),
): Promise<LocalEnvironment[]> {
  const selected = await readLocalEnvironmentSelection(home);
  const candidates = [
    ...new Set([
      ...(selected ? [selected.baseDir] : []),
      ...extra,
      ...[".t3", ".t3-rg", ".t3-alpha", ".t3-dev"].map((name) => join(home, name)),
    ]),
  ];
  // Bounded known locations only: never search project trees or arbitrary home contents.
  const found = await Promise.all(
    candidates.map(async (baseDir) => {
      try {
        await stat(baseDir);
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
      return inspectLocalEnvironment(baseDir);
    }),
  );
  return found
    .filter((entry): entry is LocalEnvironment => entry !== null)
    .filter(
      (entry, index, all) => all.findIndex((other) => other.baseDir === entry.baseDir) === index,
    );
}
