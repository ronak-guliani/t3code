import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { chromium } from "playwright";
import {
  PrMediaPublication,
  prMediaAsset,
  publishPrMedia,
  type PrMediaAsset,
} from "./lib/prMedia.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".t3", "pr-media");
const lockPath = join(directory, "lock");
const decodeReceipt = Schema.decodeUnknownSync(PrMediaPublication);
const decodePullRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.NullOr(Schema.String),
    head: Schema.Struct({ sha: Schema.String }),
    base: Schema.Struct({ repo: Schema.Struct({ id: Schema.Int }) }),
  }),
);
const decodeUpload = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }));

async function command(args: string[]): Promise<string> {
  return (await exec("gh", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout;
}

async function upload(media: PrMediaAsset, bytes: Buffer, repositoryId: number): Promise<string> {
  const token = (await command(["auth", "token", "--hostname", "github.com"])).trim();
  const url = new URL("https://uploads.github.com/user-attachments/assets");
  url.searchParams.set("name", media.file);
  url.searchParams.set("content_type", media.contentType);
  url.searchParams.set("repository_id", String(repositoryId));
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
  if (!response.ok) throw new Error(`GitHub capture upload failed (${response.status}).`);
  const payload = decodeUpload(await response.json());
  if (!payload.url.startsWith("https://github.com/user-attachments/assets/")) {
    throw new Error("GitHub did not return an attachment URL.");
  }
  return payload.url;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [prUrl, ...paths] = args[0] === "--" ? args.slice(1) : args;
  const match = prUrl?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
  if (!match || paths.length === 0) {
    throw new Error(
      "Usage: pnpm pr:media -- https://github.com/owner/repo/pull/number <capture files...>",
    );
  }
  const readPullRequest = async () =>
    decodePullRequest(JSON.parse(await command(["api", `repos/${match[1]}/pulls/${match[2]}`])));
  const files: Array<{ bytes: Buffer; media: PrMediaAsset }> = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const path of paths) {
      const bytes = await readFile(resolve(path));
      files.push({ bytes, media: await prMediaAsset(page, basename(path), bytes) });
    }
  } finally {
    await browser.close();
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(lockPath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another publication may be active. Inspect ${lockPath}/owner.json before retrying.`,
      );
    }
    throw error;
  });
  try {
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
    const pr = await readPullRequest();
    const initial: PrMediaPublication = {
      pullRequestUrl: prUrl!,
      headSha: pr.head.sha,
      media: files.map((file) => file.media),
    };
    const key = createHash("sha256").update(JSON.stringify(initial)).digest("hex");
    const receiptPath = join(directory, `${key}.json`);
    let publication = initial;
    try {
      publication = decodeReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
    }
    if (
      publication.pullRequestUrl !== initial.pullRequestUrl ||
      publication.headSha !== initial.headSha ||
      publication.media.length !== initial.media.length ||
      publication.media.some((media, index) => {
        const expected = initial.media[index]!;
        return (
          media.file !== expected.file ||
          media.contentType !== expected.contentType ||
          media.sha256 !== expected.sha256 ||
          media.sizeBytes !== expected.sizeBytes
        );
      })
    ) {
      throw new Error("The upload receipt does not match the supplied captures.");
    }
    const save = async (receipt: PrMediaPublication) => {
      const temporary = `${receiptPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      await rename(temporary, receiptPath);
    };
    console.log(`Upload receipt: ${receiptPath}`);
    await publishPrMedia(publication, {
      upload: (item, index) => upload(item, files[index]!.bytes, pr.base.repo.id),
      save,
      readPullRequest,
      updateBody: async (body) => {
        const bodyPath = join(directory, `${key}.body.txt`);
        await writeFile(bodyPath, body, { mode: 0o600 });
        await command(["pr", "edit", prUrl!, "--body-file", bodyPath]);
      },
    });
    console.log(
      `Published captures to ${prUrl}. Uploaded bytes verified; feature testing remains the agent's responsibility.`,
    );
  } finally {
    await rm(join(lockPath, "owner.json"), { force: true });
    await rm(lockPath, { recursive: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Capture publication failed.");
  console.error(
    "Saved upload URLs are retained for retry. Inspect GitHub before retrying an upload with an ambiguous outcome.",
  );
  process.exitCode = 1;
});
