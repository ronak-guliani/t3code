import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Schema } from "effect";
import { resolveWindowsSpawn } from "@t3tools/shared/shell";
import {
  SelfTestManifest,
  SelfTestCapture,
  SelfTestDiagnostics,
  parseSelfTestCommand,
  selfTestBlockers,
} from "./lib/selfTestEvidence.ts";
import { readSelfTestRevision } from "./lib/selfTestRevision.ts";

const decodeManifest = Schema.decodeUnknownSync(SelfTestManifest);
const decodeCapture = Schema.decodeUnknownSync(SelfTestCapture);
const decodeDiagnostics = Schema.decodeUnknownSync(SelfTestDiagnostics);
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".t3", "self-test");
const latestPath = join(directory, "latest.json");
const lockPath = join(directory, "lock");
const revision = () => readSelfTestRevision(root);

async function save(manifest: SelfTestManifest): Promise<void> {
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(directory, manifest.runId, "manifest.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
  const latestTemporary = `${latestPath}.${randomUUID()}.tmp`;
  await writeFile(latestTemporary, data, { mode: 0o600 });
  await rename(latestTemporary, latestPath);
}

async function load(): Promise<SelfTestManifest> {
  const manifest = decodeManifest(JSON.parse(await readFile(latestPath, "utf8")));
  if (!/^[a-f0-9-]{36}$/.test(manifest.runId)) throw new Error("Invalid self-test run ID.");
  return manifest;
}

async function checkFiles(manifest: SelfTestManifest): Promise<void> {
  for (const media of manifest.media) {
    if (basename(media.file) !== media.file) {
      throw new Error("Baseline capture must be a run-local filename.");
    }
    const bytes = await readFile(join(directory, manifest.runId, media.file));
    if (
      bytes.length !== media.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== media.sha256
    ) {
      throw new Error("Baseline capture content changed after the run.");
    }
  }
}

async function run(): Promise<void> {
  const runId = randomUUID();
  const output = join(directory, runId);
  await mkdir(output, { recursive: true, mode: 0o700 });
  let manifest: SelfTestManifest = {
    version: 1,
    runId,
    revision: await revision(),
    status: "running",
    startedAt: new Date().toISOString(),
    command: "pnpm test:direct-connect-smoke",
    scenarios: [],
    media: [],
  };
  await save(manifest);
  const invocation = resolveWindowsSpawn("pnpm");
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(invocation.command, ["test:direct-connect-smoke"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, T3_SELF_TEST_OUTPUT: output },
      ...(invocation.shell ? { shell: invocation.shell } : {}),
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  manifest = { ...manifest, status: "failed", exitCode, completedAt: new Date().toISOString() };
  await save(manifest);
  if ((await readdir(output)).includes("diagnostics.json")) {
    manifest = {
      ...manifest,
      diagnostics: decodeDiagnostics(
        JSON.parse(await readFile(join(output, "diagnostics.json"), "utf8")),
      ),
    };
    await save(manifest);
  }
  if (exitCode !== 0)
    throw new Error(`Pairing/reconnect smoke test failed (exit ${exitCode}); see ${output}.`);
  const capture = decodeCapture(JSON.parse(await readFile(join(output, "capture.json"), "utf8")));
  const captured: SelfTestManifest = { ...manifest, ...capture, status: "passed" };
  const blockers = selfTestBlockers(captured, await revision());
  await checkFiles(captured);
  if (blockers.length) throw new Error(blockers.join("\n"));
  await save(captured);
  console.log(
    `Pairing/reconnect smoke test passed: ${output}\nScope: baseline only, not feature validation. Captures are local diagnostics, not PR evidence.`,
  );
}

async function main(): Promise<void> {
  const command = parseSelfTestCommand(process.argv.slice(2).filter((arg) => arg !== "--"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(lockPath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another self-test operation may be active. Inspect ${lockPath}; do not start competing runs.`,
      );
    }
    throw error;
  });
  try {
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    if (command === "run") {
      await run();
    } else {
      const manifest = await load();
      await checkFiles(manifest);
      const blockers = selfTestBlockers(manifest, await revision());
      console.log(JSON.stringify({ ...manifest, scope: "baseline-only", blockers }, null, 2));
      if (blockers.length) process.exitCode = 1;
    }
  } finally {
    await rm(join(lockPath, "owner.json"), { force: true });
    await rm(lockPath, { recursive: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Self-test operation failed.");
  process.exitCode = 1;
});
