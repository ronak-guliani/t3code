import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { resolveWindowsSpawn } from "@t3tools/shared/shell";
import {
  SelfTestManifest,
  SelfTestCapture,
  selfTestBlockers,
  replaceSelfTestSection,
  type SelfTestMedia,
} from "./lib/selfTestEvidence.ts";
import { readSelfTestRevision } from "./lib/selfTestRevision.ts";
import { verifySelfTestMedia } from "./lib/selfTestPublication.ts";

const exec = promisify(execFile);
const decodeManifest = Schema.decodeUnknownSync(SelfTestManifest);
const decodeCapture = Schema.decodeUnknownSync(SelfTestCapture);
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".t3", "self-test");
const latestPath = join(directory, "latest.json");
const lockPath = join(directory, "lock");

async function command(file: string, args: string[]): Promise<string> {
  const result = await exec(file, args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

const revision = () => readSelfTestRevision(root);
const PullRequestSnapshot = Schema.Struct({
  body: Schema.NullOr(Schema.String),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ repo: Schema.Struct({ id: Schema.Int }) }),
});
const decodePullRequest = Schema.decodeUnknownSync(PullRequestSnapshot);

function pullRequestSelector(prUrl: string | undefined) {
  const match = prUrl?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
  if (!match) throw new Error("Provide an exact https://github.com/owner/repo/pull/number URL.");
  return `repos/${match[1]}/pulls/${match[2]}`;
}

async function readPullRequest(prUrl: string | undefined) {
  return decodePullRequest(JSON.parse(await command("gh", ["api", pullRequestSelector(prUrl)])));
}

async function verifyPublication(manifest: SelfTestManifest): Promise<void> {
  if (!manifest.publication) throw new Error("Evidence has not been attached to a PR.");
  const pr = await readPullRequest(manifest.publication.pullRequestUrl);
  if (pr.head.sha !== manifest.revision.commit) {
    throw new Error("Published evidence is stale: the PR head changed.");
  }
  for (const media of manifest.media) {
    if (
      !media.url?.startsWith("https://github.com/user-attachments/assets/") ||
      !pr.body?.includes(media.url)
    ) {
      throw new Error("A published artifact is missing from the PR.");
    }
    await verifySelfTestMedia(media);
  }
}

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
    if (basename(media.file) !== media.file)
      throw new Error("Evidence must be a run-local filename.");
    const bytes = await readFile(join(directory, manifest.runId, media.file));
    if (
      bytes.length !== media.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== media.sha256
    ) {
      throw new Error("Evidence content changed after validation.");
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
  if (exitCode !== 0) throw new Error(`Self-test failed (exit ${exitCode}); see ${output}.`);
  const capture = decodeCapture(JSON.parse(await readFile(join(output, "capture.json"), "utf8")));
  const captured: SelfTestManifest = { ...manifest, ...capture, status: "passed" };
  const blockers = selfTestBlockers(captured, await revision(), false);
  await checkFiles(captured);
  if (blockers.length) throw new Error(blockers.join("\n"));
  await save(captured);
  console.log(
    `Verified web baseline: ${output}\nRun pnpm test:self -- publish <PR URL> to attach evidence.`,
  );
}

async function upload(
  media: SelfTestMedia,
  manifest: SelfTestManifest,
  repositoryId: number,
): Promise<string> {
  const token = (await command("gh", ["auth", "token", "--hostname", "github.com"])).trim();
  const url = new URL("https://uploads.github.com/user-attachments/assets");
  url.searchParams.set("name", media.file);
  url.searchParams.set("content_type", media.kind === "screenshot" ? "image/png" : "video/webm");
  url.searchParams.set("repository_id", String(repositoryId));
  const bytes = await readFile(join(directory, manifest.runId, media.file));
  if (createHash("sha256").update(bytes).digest("hex") !== media.sha256) {
    throw new Error("Evidence changed before upload.");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
    },
    body: bytes,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`GitHub evidence upload failed (${response.status}); files retained.`);
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    !("url" in payload) ||
    typeof payload.url !== "string" ||
    !payload.url.startsWith("https://github.com/user-attachments/assets/")
  ) {
    throw new Error("GitHub did not return an attachment URL.");
  }
  return payload.url;
}

async function publish(prUrl: string | undefined): Promise<void> {
  pullRequestSelector(prUrl);
  let manifest = await load();
  const blockers = selfTestBlockers(manifest, await revision(), false);
  if (blockers.length) throw new Error(blockers.join("\n"));
  await checkFiles(manifest);
  const pr = await readPullRequest(prUrl);
  if (pr.head.sha !== manifest.revision.commit)
    throw new Error("The PR head differs from the tested commit.");
  if ((await command("git", ["status", "--porcelain"])).length) {
    throw new Error("Commit changes and rerun self-testing before publishing PR evidence.");
  }
  for (let index = 0; index < manifest.media.length; index += 1) {
    const item = manifest.media[index]!;
    if (!item.url) {
      const url = await upload(item, manifest, pr.base.repo.id);
      manifest = Object.assign({}, manifest, {
        media: manifest.media.map((media, i) => (i === index ? { ...media, url } : media)),
      });
      await save(manifest);
    }
  }
  const section = [
    "## Self-test evidence",
    `Tested commit: \`${manifest.revision.commit}\`. Scope: production web pairing/reconnect baseline, not native Electron or feature-specific coverage.`,
    ...manifest.scenarios.map((scenario) => `- ${scenario}`),
    ...manifest.media.map((media) =>
      media.kind === "screenshot"
        ? `\n![Self-test screenshot: ${media.file}](${media.url})`
        : `\n${media.url}`,
    ),
  ].join("\n\n");
  const fresh = await readPullRequest(prUrl);
  if (fresh.head.sha !== manifest.revision.commit)
    throw new Error("The PR changed during publication.");
  const finalBlockers = selfTestBlockers(manifest, await revision(), false);
  if (finalBlockers.length) throw new Error(finalBlockers.join("\n"));
  await checkFiles(manifest);
  const body = replaceSelfTestSection(fresh.body ?? "", section);
  const bodyPath = join(directory, manifest.runId, "pr-body.txt");
  await writeFile(bodyPath, body, { mode: 0o600 });
  await command("gh", ["pr", "edit", prUrl!, "--body-file", bodyPath]);
  const published = { ...manifest, publication: { pullRequestUrl: prUrl! } };
  await verifyPublication(published);
  await save(published);
  console.log(`Published verified web baseline evidence to ${prUrl}`);
}

async function main(): Promise<void> {
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
    const args = process.argv.slice(2).filter((arg) => arg !== "--");
    switch (args[0] ?? "run") {
      case "run":
        await run();
        break;
      case "publish":
        await publish(args[1]);
        break;
      case "status": {
        const manifest = await load();
        await checkFiles(manifest);
        const blockers = selfTestBlockers(
          manifest,
          await revision(),
          args.includes("--require-published"),
        );
        if (blockers.length === 0 && args.includes("--require-published")) {
          await verifyPublication(manifest);
        }
        console.log(JSON.stringify({ ...manifest, blockers }, null, 2));
        if (blockers.length) process.exitCode = 1;
        break;
      }
      default:
        throw new Error(
          "Usage: pnpm test:self -- [run|status [--require-published]|publish <PR URL>]",
        );
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
