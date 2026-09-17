import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { resolveWindowsSpawn } from "@t3tools/shared/shell";
import {
  classifySelfTestLock,
  redactSelfTestText,
  selfTestBlockers,
  selfTestStatus,
  SelfTestCapture,
  SelfTestDiagnostics,
  SelfTestIssue,
  SelfTestManifest,
  SelfTestMedia,
  SelfTestRevision,
  SelfTestStageUpdate,
  type SelfTestEnvironment,
  type SelfTestArtifact,
  type SelfTestLockOwner,
  type SelfTestProcess,
} from "./lib/selfTestEvidence.ts";
import { readSelfTestRevision } from "./lib/selfTestRevision.ts";

const exec = promisify(execFile);
const decodeManifest = Schema.decodeUnknownSync(SelfTestManifest);
const decodeCapture = Schema.decodeUnknownSync(SelfTestCapture);
const decodeDiagnostics = Schema.decodeUnknownSync(SelfTestDiagnostics);
const decodeMedia = Schema.decodeUnknownSync(Schema.Array(SelfTestMedia));
const decodeRevision = Schema.decodeUnknownSync(SelfTestRevision);
const decodeStageUpdate = Schema.decodeUnknownSync(SelfTestStageUpdate);
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".t3", "self-test");
const commandArgs = ["test:direct-connect-smoke"];
const commandText = "pnpm test:direct-connect-smoke";

type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type CoordinatorOptions = {
  readonly root?: string;
  readonly directory?: string;
  readonly now?: () => string;
  readonly spawnChild?: typeof spawn;
  readonly processAlive?: (pid: number) => boolean;
  readonly processCommand?: (pid: number) => Promise<string>;
};

export class SelfTestCoordinatorError extends Error {
  readonly stage: SelfTestManifest["stage"];
  readonly issue: SelfTestIssue;
  readonly artifactDirectory: string;

  constructor(stage: SelfTestManifest["stage"], issue: SelfTestIssue, artifactDirectory: string) {
    super(
      `Self-test ${issue.type} during ${stage}: ${redactSelfTestText(issue.message)} ` +
        `Action: ${redactSelfTestText(issue.action)} Artifacts: ${artifactDirectory}`,
    );
    this.name = "SelfTestCoordinatorError";
    this.stage = stage;
    this.issue = issue;
    this.artifactDirectory = artifactDirectory;
  }
}

export type SelfTestCoordinator = {
  readonly run: () => Promise<SelfTestManifest>;
  readonly status: () => Promise<{
    readonly status: string;
    readonly manifest?: SelfTestManifest;
    readonly blockers: ReadonlyArray<SelfTestIssue>;
  }>;
};

function issue(type: SelfTestIssue["type"], message: string, action: string): SelfTestIssue {
  return { type, message: redactSelfTestText(message), action: redactSelfTestText(action) };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code !== "ESRCH";
  }
}

async function processCommand(pid: number): Promise<string> {
  const result = await exec("ps", ["-p", String(pid), "-o", "command="], {
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

function commandMatches(command: string): boolean {
  return command.includes("scripts/self-test.ts") || command.includes("test:self");
}

function environment(rootDirectory: string): SelfTestEnvironment {
  return {
    baseDirectory: rootDirectory,
    webTarget: process.env.T3_SELF_TEST_WEB_TARGET ?? resolve(rootDirectory, "apps/web/dist"),
  };
}

function childProcess(
  role: SelfTestProcess["role"],
  pid: number,
  startedAt: string,
): SelfTestProcess {
  return {
    role,
    pid,
    command: commandText,
    startedAt,
  };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

async function saveManifest(baseDirectory: string, manifest: SelfTestManifest): Promise<void> {
  const runDirectory = join(baseDirectory, manifest.runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeAtomic(join(runDirectory, "manifest.json"), data);
  await writeAtomic(join(baseDirectory, "latest.json"), data);
}

async function readManifest(path: string): Promise<SelfTestManifest> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (raw.version === 1) {
    const revision = decodeRevision(raw.revision);
    const runId = String(raw.runId);
    const startedAt = String(raw.startedAt);
    const status = raw.status === "running" ? "active" : raw.status;
    const media = Array.isArray(raw.media) ? decodeMedia(raw.media) : [];
    const migrated: SelfTestManifest = {
      version: 2,
      runId,
      revision,
      status: status === "passed" || status === "failed" ? status : "interrupted",
      stage: status === "passed" ? "passed" : status === "failed" ? "failed" : "interrupted",
      startedAt,
      ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
      command: typeof raw.command === "string" ? raw.command : commandText,
      process: {
        role: "coordinator",
        pid: 0,
        command: typeof raw.command === "string" ? raw.command : commandText,
        startedAt,
      },
      environment: environment(root),
      ...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}),
      scenarios: Array.isArray(raw.scenarios)
        ? raw.scenarios.filter((value): value is string => typeof value === "string")
        : [],
      media,
      ...(raw.diagnostics ? { diagnostics: decodeDiagnostics(raw.diagnostics) } : {}),
      artifacts: [],
    };
    return migrated;
  }
  return decodeManifest(raw);
}

async function loadLatest(baseDirectory: string): Promise<SelfTestManifest | undefined> {
  try {
    return await readManifest(join(baseDirectory, "latest.json"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function hashFile(
  path: string,
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

async function collectArtifacts(
  runDirectory: string,
  current = "",
): Promise<SelfTestManifest["artifacts"]> {
  const entries = await readdir(join(runDirectory, current), { withFileTypes: true });
  const artifacts: SelfTestArtifact[] = [];
  for (const entry of entries) {
    const file = join(current, entry.name);
    if (file === "manifest.json") continue;
    const absolute = join(runDirectory, file);
    if (entry.isDirectory()) {
      artifacts.push(...(await collectArtifacts(runDirectory, file)));
      continue;
    }
    if (!entry.isFile()) continue;
    const hash = await hashFile(absolute);
    artifacts.push({ file, ...hash });
  }
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

async function checkArtifacts(baseDirectory: string, manifest: SelfTestManifest): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const artifactPath = resolve(baseDirectory, manifest.runId, artifact.file);
    const artifactRelative = relative(join(baseDirectory, manifest.runId), artifactPath);
    if (artifactRelative.startsWith("..") || artifactRelative.startsWith("/")) {
      throw new Error("Self-test artifact must remain inside its run directory.");
    }
    const actual = await hashFile(artifactPath);
    if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Self-test artifact content changed: ${artifact.file}.`);
    }
  }
  for (const media of manifest.media) {
    if (basename(media.file) !== media.file) {
      throw new Error("Baseline capture must be a run-local filename.");
    }
    const actual = await hashFile(join(baseDirectory, manifest.runId, media.file));
    if (actual.sha256 !== media.sha256 || actual.sizeBytes !== media.sizeBytes) {
      throw new Error("Baseline capture content changed after the run.");
    }
  }
}

async function readLockOwner(path: string): Promise<SelfTestLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SelfTestLockOwner>;
    if (
      typeof value.pid !== "number" ||
      typeof value.runId !== "string" ||
      typeof value.command !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    return value as SelfTestLockOwner;
  } catch {
    return undefined;
  }
}

async function inspectLock(
  lockDirectory: string,
  alive: (pid: number) => boolean,
  command: (pid: number) => Promise<string>,
) {
  try {
    await access(lockDirectory);
  } catch {
    return { status: "missing" } as const;
  }
  const owner = await readLockOwner(join(lockDirectory, "owner.json"));
  if (!owner)
    return { status: "ambiguous", reason: "The lock owner record is unreadable." } as const;
  const actualCommand = await command(owner.pid).catch(() => "");
  return classifySelfTestLock(owner, alive(owner.pid), commandMatches(actualCommand));
}

async function acquireLock(
  lockDirectory: string,
  runId: string,
  alive: (pid: number) => boolean,
  command: (pid: number) => Promise<string>,
  loadCurrent: () => Promise<SelfTestManifest | undefined>,
): Promise<void> {
  try {
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
    const state = await inspectLock(lockDirectory, alive, command);
    if (state.status === "active") {
      throw new SelfTestCoordinatorError(
        "pending",
        issue(
          "lock-contention",
          `Another self-test run ${state.owner.runId} owns the coordinator lock.`,
          "Inspect the active run and wait for it to finish.",
        ),
        dirnameForRun(lockDirectory),
      );
    }
    if (state.status === "ambiguous") {
      throw new SelfTestCoordinatorError(
        "pending",
        issue(
          "lock-ambiguous",
          state.reason,
          "Inspect lock/owner.json and the owning process; do not remove ambiguous state.",
        ),
        dirnameForRun(lockDirectory),
      );
    }
    const current = await loadCurrent();
    if (
      current?.status === "active" &&
      current.process.role === "child" &&
      alive(current.process.pid)
    ) {
      throw new SelfTestCoordinatorError(
        "pending",
        issue(
          "lock-ambiguous",
          "The coordinator lock owner stopped while the self-test child is still alive.",
          "Inspect the child process and run artifacts before retrying.",
        ),
        dirnameForRun(lockDirectory),
      );
    }
    await rm(lockDirectory, { recursive: true, force: true });
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  }
  await writeAtomic(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      runId,
      command: commandText,
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

function dirnameForRun(lockDirectory: string): string {
  return resolve(lockDirectory, "..");
}

async function releaseLock(lockDirectory: string, runId: string): Promise<void> {
  const owner = await readLockOwner(join(lockDirectory, "owner.json"));
  if (!owner || owner.runId !== runId || owner.pid !== process.pid) return;
  await rm(lockDirectory, { recursive: true, force: true });
}

function stageStatus(stage: SelfTestManifest["stage"]): SelfTestManifest["status"] {
  switch (stage) {
    case "pending":
      return "pending";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "passed":
      return "active";
    case "preflight":
    case "pairing":
    case "assertions":
    case "capture":
      return "active";
  }
}

async function readStageUpdate(runDirectory: string): Promise<SelfTestStageUpdate | undefined> {
  try {
    return decodeStageUpdate(
      JSON.parse(await readFile(join(runDirectory, "lifecycle.json"), "utf8")),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readOptionalJson<T>(
  path: string,
  decode: (value: unknown) => T,
): Promise<T | undefined> {
  try {
    return decode(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function childExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

export function createSelfTestCoordinator(options: CoordinatorOptions = {}): SelfTestCoordinator {
  const projectRoot = options.root ?? root;
  const stateDirectory = options.directory ?? join(projectRoot, ".t3", "self-test");
  const now = options.now ?? (() => new Date().toISOString());
  const spawnChild = options.spawnChild ?? spawn;
  const alive = options.processAlive ?? processAlive;
  const command = options.processCommand ?? processCommand;
  const lockDirectory = join(stateDirectory, "lock");

  const updateManifestFromStage = async (manifest: SelfTestManifest): Promise<SelfTestManifest> => {
    const update = await readStageUpdate(join(stateDirectory, manifest.runId));
    if (!update) return manifest;
    return {
      ...manifest,
      stage: update.stage,
      status: stageStatus(update.stage),
      ...(update.scenarios ? { scenarios: [...update.scenarios] } : {}),
      ...(update.blocker ? { blocker: update.blocker } : {}),
      ...(update.failure ? { failure: update.failure } : {}),
    };
  };

  const run = async (): Promise<SelfTestManifest> => {
    const runId = randomUUID();
    const output = join(stateDirectory, runId);
    const startedAt = now();
    const webTarget = process.env.T3_SELF_TEST_WEB_TARGET ?? resolve(projectRoot, "apps/web/dist");
    const currentRevision = await readSelfTestRevision(projectRoot);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await acquireLock(lockDirectory, runId, alive, command, () => loadLatest(stateDirectory));

    let manifest: SelfTestManifest = {
      version: 2,
      runId,
      revision: currentRevision,
      status: "pending",
      stage: "pending",
      startedAt,
      command: commandText,
      process: childProcess("coordinator", process.pid, startedAt),
      environment: { baseDirectory: projectRoot, webTarget },
      scenarios: [],
      media: [],
      artifacts: [],
    };
    await saveManifest(stateDirectory, manifest);

    let child: ChildProcess | undefined;
    let requestedSignal: NodeJS.Signals | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      requestedSignal = signal;
      child?.kill("SIGTERM");
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let watching = true;
    const watch = (async () => {
      while (true) {
        if (!watching) break;
        const next = await updateManifestFromStage(manifest);
        if (next.stage !== manifest.stage || next.status !== manifest.status) {
          manifest = next;
          await saveManifest(stateDirectory, manifest);
        } else if (next.scenarios.length !== manifest.scenarios.length) {
          manifest = next;
          await saveManifest(stateDirectory, manifest);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    })();

    try {
      manifest = {
        ...manifest,
        stage: "preflight",
        status: "active",
        process: childProcess("coordinator", process.pid, startedAt),
      };
      await saveManifest(stateDirectory, manifest);
      if (process.env.T3_SELF_TEST_WEB_TARGET) {
        try {
          await access(join(resolve(webTarget), "index.html"));
        } catch {
          const blocker = issue(
            "web-target-missing",
            `The configured web target is missing index.html: ${resolve(webTarget)}.`,
            "Build the web app and verify T3_SELF_TEST_WEB_TARGET before rerunning.",
          );
          manifest = {
            ...manifest,
            status: "blocked",
            stage: "blocked",
            blocker,
            completedAt: now(),
            artifacts: await collectArtifacts(output).catch(() => []),
          };
          await saveManifest(stateDirectory, manifest);
          throw new SelfTestCoordinatorError("preflight", blocker, output);
        }
      }

      const invocation = resolveWindowsSpawn("pnpm");
      child = spawnChild(invocation.command, commandArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          T3_SELF_TEST_OUTPUT: output,
          T3_SELF_TEST_WEB_TARGET: webTarget,
        },
        ...(invocation.shell ? { shell: invocation.shell } : {}),
      });
      manifest = {
        ...manifest,
        process: childProcess("child", child.pid ?? 0, now()),
      };
      await saveManifest(stateDirectory, manifest);
      const result = await childExit(child);
      watching = false;
      await watch;
      manifest = await updateManifestFromStage(manifest);

      const diagnostics = await readOptionalJson(
        join(output, "diagnostics.json"),
        decodeDiagnostics,
      );
      const capture = await readOptionalJson(join(output, "capture.json"), decodeCapture);
      const artifacts = await collectArtifacts(output);
      if (diagnostics) manifest = { ...manifest, diagnostics };
      manifest = {
        ...manifest,
        artifacts,
        ...(result.code === null ? {} : { exitCode: result.code }),
      };

      if (requestedSignal || result.signal) {
        const failure = issue(
          "interrupted",
          `The self-test process was interrupted${result.signal ? ` by ${result.signal}` : ""}.`,
          "Inspect the retained diagnostics and raw captures, then rerun pnpm test:self.",
        );
        manifest = {
          ...manifest,
          status: "interrupted",
          stage: "interrupted",
          signal: requestedSignal ?? result.signal ?? undefined,
          failure,
          completedAt: now(),
        };
        await saveManifest(stateDirectory, manifest);
        throw new SelfTestCoordinatorError("interrupted", failure, output);
      }

      if (manifest.stage === "blocked" || manifest.blocker) {
        const blocker =
          manifest.blocker ??
          issue(
            "backend-unhealthy",
            "The self-test was blocked during preflight.",
            "Inspect the preflight diagnostics and rerun after addressing the blocker.",
          );
        manifest = {
          ...manifest,
          status: "blocked",
          stage: "blocked",
          blocker,
          completedAt: now(),
        };
        await saveManifest(stateDirectory, manifest);
        throw new SelfTestCoordinatorError("blocked", blocker, output);
      }

      if (result.code !== 0) {
        const failure = issue(
          manifest.stage === "assertions" || manifest.stage === "capture"
            ? "assertion-failed"
            : "process-exit",
          `The pairing/reconnect smoke process exited with code ${result.code ?? 1}.`,
          "Inspect diagnostics.json and raw captures before rerunning pnpm test:self.",
        );
        manifest = {
          ...manifest,
          status: "failed",
          stage: "failed",
          failure,
          completedAt: now(),
        };
        await saveManifest(stateDirectory, manifest);
        throw new SelfTestCoordinatorError("failed", failure, output);
      }

      if (!capture) {
        const failure = issue(
          "capture-invalid",
          "The smoke process exited successfully without a structured capture result.",
          "Inspect the raw capture and diagnostics files, then rerun pnpm test:self.",
        );
        manifest = {
          ...manifest,
          status: "failed",
          stage: "failed",
          failure,
          completedAt: now(),
        };
        await saveManifest(stateDirectory, manifest);
        throw new SelfTestCoordinatorError("capture", failure, output);
      }

      const candidate: SelfTestManifest = {
        ...manifest,
        status: "passed",
        stage: "passed",
        scenarios: capture.scenarios,
        media: capture.media,
        diagnostics: capture.diagnostics,
        completedAt: now(),
      };
      const blockers = [...selfTestBlockers(candidate, currentRevision)];
      try {
        await checkArtifacts(stateDirectory, candidate);
      } catch (error) {
        blockers.push(
          issue(
            "capture-invalid",
            error instanceof Error ? error.message : "Self-test artifact integrity check failed.",
            "Inspect the retained artifacts and rerun pnpm test:self.",
          ),
        );
      }
      if (blockers.length) {
        const failure = blockers[0]!;
        manifest = {
          ...candidate,
          status: "failed",
          stage: "failed",
          failure,
        };
        await saveManifest(stateDirectory, manifest);
        throw new SelfTestCoordinatorError("capture", failure, output);
      }
      manifest = candidate;
      await saveManifest(stateDirectory, manifest);
      return manifest;
    } catch (error) {
      watching = false;
      await watch;
      if (error instanceof SelfTestCoordinatorError) throw error;
      const failure = issue(
        "process-start",
        error instanceof Error ? error.message : "The self-test process could not start.",
        "Inspect the artifact directory and rerun pnpm test:self.",
      );
      manifest = {
        ...manifest,
        status: "failed",
        stage: "failed",
        failure,
        completedAt: now(),
        artifacts: await collectArtifacts(output).catch(() => []),
      };
      await saveManifest(stateDirectory, manifest);
      throw new SelfTestCoordinatorError("failed", failure, output);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await releaseLock(lockDirectory, runId);
    }
  };

  const status = async () => {
    let manifest: SelfTestManifest | undefined;
    try {
      manifest = await loadLatest(stateDirectory);
    } catch (error) {
      const invalid = issue(
        "manifest-invalid",
        error instanceof Error ? error.message : "The self-test manifest could not be decoded.",
        "Inspect latest.json and the run directory before rerunning pnpm test:self.",
      );
      throw new SelfTestCoordinatorError("pending", invalid, stateDirectory);
    }
    if (!manifest) return { status: "never-run", blockers: [] as ReadonlyArray<SelfTestIssue> };
    const current = await readSelfTestRevision(projectRoot);
    let effective = manifest;
    if (
      (manifest.status === "active" || manifest.status === "pending") &&
      manifest.process.pid > 0 &&
      !alive(manifest.process.pid)
    ) {
      const failure = issue(
        "interrupted",
        "The self-test coordinator or child process is no longer running.",
        "Inspect retained diagnostics and raw captures, then rerun pnpm test:self.",
      );
      effective = {
        ...manifest,
        status: "interrupted",
        stage: "interrupted",
        failure,
        completedAt: now(),
      };
      await saveManifest(stateDirectory, effective);
    }
    if (effective.status === "passed") {
      try {
        await checkArtifacts(stateDirectory, effective);
      } catch (error) {
        const failure = issue(
          "capture-invalid",
          error instanceof Error ? error.message : "Self-test artifact integrity check failed.",
          "Inspect the retained artifacts and rerun pnpm test:self.",
        );
        effective = {
          ...effective,
          status: "failed",
          stage: "failed",
          failure,
          completedAt: now(),
        };
        await saveManifest(stateDirectory, effective);
      }
    }
    const blockers = effective.status === "passed" ? [...selfTestBlockers(effective, current)] : [];
    return {
      status: selfTestStatus(effective, current),
      manifest: effective,
      blockers,
    };
  };

  return { run, status };
}

export function parseSelfTestArgs(args: ReadonlyArray<string>): "run" | "status" {
  const command = args[0] ?? "run";
  if (args.length > 1 || (command !== "run" && command !== "status")) {
    throw new Error(
      "Usage: pnpm test:self -- [run|status]. This command only tests pairing/reconnect. " +
        "Feature reports and publication flags are no longer supported.",
    );
  }
  return command;
}

async function main(): Promise<void> {
  const command = parseSelfTestArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const coordinator = createSelfTestCoordinator();
  if (command === "status") {
    const result = await coordinator.status();
    console.log(
      JSON.stringify(
        {
          ...result,
          scope: "baseline-only",
          artifactDirectory: result.manifest
            ? join(directory, result.manifest.runId)
            : join(directory, "<not-started>"),
        },
        null,
        2,
      ),
    );
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }

  const manifest = await coordinator.run();
  console.log(
    `Pairing/reconnect smoke test passed: ${join(directory, manifest.runId)}\n` +
      "Scope: baseline only, not feature validation. Captures are local diagnostics, not PR evidence.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? redactSelfTestText(error.message)
        : "Self-test operation failed during an unknown stage.",
    );
    process.exitCode = 1;
  });
}
