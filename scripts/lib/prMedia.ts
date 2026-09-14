import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Schema } from "effect";
import type { Page } from "playwright";
import { inspectMediaIntegrity, MediaContentType } from "./mediaIntegrity.ts";

export const PrMediaAsset = Schema.Struct({
  file: Schema.String,
  contentType: MediaContentType,
  sha256: Schema.String,
  sizeBytes: Schema.Int,
  url: Schema.optional(Schema.String),
});
export type PrMediaAsset = typeof PrMediaAsset.Type;

export const PrMediaPublication = Schema.Struct({
  pullRequestUrl: Schema.String,
  headSha: Schema.String,
  media: Schema.Array(PrMediaAsset),
});
export type PrMediaPublication = typeof PrMediaPublication.Type;

export async function prMediaAsset(page: Page, file: string, bytes: Buffer): Promise<PrMediaAsset> {
  const extension = extname(file).toLowerCase();
  const contentType =
    extension === ".png"
      ? "image/png"
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".webm"
          ? "video/webm"
          : extension === ".mp4"
            ? "video/mp4"
            : undefined;
  if (!contentType) throw new Error("PR captures must be PNG, JPEG, WebM, or MP4 files.");
  if (bytes.length === 0) throw new Error("Cannot publish an empty capture.");
  await inspectMediaIntegrity(page, bytes, contentType);
  return {
    file,
    contentType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function prMediaSection(publication: PrMediaPublication): string {
  if (publication.media.length === 0) throw new Error("No captures were supplied.");
  return [
    "## Feature captures",
    `PR head at upload: \`${publication.headSha}\`. See the testing notes for exercised behavior and limitations; uploading media is not a test result.`,
    ...publication.media.map((media) => {
      if (!media.url?.startsWith("https://github.com/user-attachments/assets/")) {
        throw new Error("Capture has not been uploaded to GitHub.");
      }
      const label = media.file.replace(/\s+/g, " ").replace(/[\\[\]<>`]/g, "");
      return media.contentType.startsWith("image/")
        ? `![${label}](${media.url})`
        : `${label}\n\n${media.url}`;
    }),
  ].join("\n\n");
}

export function replacePrMediaSection(body: string, section: string): string {
  const start = "<!-- t3-pr-media:start -->";
  const end = "<!-- t3-pr-media:end -->";
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (
    first < 0 !== last < 0 ||
    (first >= 0 && last < first) ||
    (first >= 0 && body.indexOf(start, first + start.length) >= 0) ||
    (last >= 0 && body.indexOf(end, last + end.length) >= 0)
  ) {
    throw new Error("The PR contains an ambiguous media section.");
  }
  const managed = `${start}\n${section}\n${end}`;
  return first < 0
    ? `${body.trimEnd()}\n\n${managed}\n`
    : `${body.slice(0, first)}${managed}${body.slice(last + end.length)}`;
}

interface PublicationSnapshot {
  readonly head: { readonly sha: string };
  readonly body: string | null;
}

export async function publishPrMedia(
  initial: PrMediaPublication,
  operations: {
    readonly upload: (media: PrMediaAsset, index: number) => Promise<string>;
    readonly save: (publication: PrMediaPublication) => Promise<void>;
    readonly readPullRequest: () => Promise<PublicationSnapshot>;
    readonly updateBody: (body: string) => Promise<void>;
    readonly fetch?: typeof fetch;
  },
): Promise<void> {
  let publication = initial;
  await operations.save(publication);
  for (let index = 0; index < publication.media.length; index += 1) {
    const item = publication.media[index]!;
    if (item.url) continue;
    const url = await operations.upload(item, index);
    publication = Object.assign({}, publication, {
      media: publication.media.map((media, i) => (i === index ? { ...media, url } : media)),
    });
    await operations.save(publication);
  }
  const fresh = await operations.readPullRequest();
  if (fresh.head.sha !== publication.headSha) {
    throw new Error("The PR head changed during upload; captures were not attached.");
  }
  await operations.updateBody(replacePrMediaSection(fresh.body ?? "", prMediaSection(publication)));
  await verifyPrMediaPublication(publication, operations.readPullRequest, operations.fetch);
}

export async function verifyPrMediaPublication(
  publication: PrMediaPublication,
  readPullRequest: (url: string) => Promise<PublicationSnapshot>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const section = prMediaSection(publication);
  const media = publication.media;
  const verifySnapshot = (pr: PublicationSnapshot) => {
    if (pr.head.sha !== publication.headSha) {
      throw new Error("Published evidence is stale: the PR head changed.");
    }
    for (const item of media) {
      if (
        !item.url?.startsWith("https://github.com/user-attachments/assets/") ||
        !pr.body?.includes(item.url)
      ) {
        throw new Error("A published artifact is missing from the PR.");
      }
    }
    if (!pr.body?.includes(`<!-- t3-pr-media:start -->\n${section}\n<!-- t3-pr-media:end -->`)) {
      throw new Error("The published media section is missing or changed.");
    }
  };
  verifySnapshot(await readPullRequest(publication.pullRequestUrl));
  for (const item of media) await verifyPrMedia(item, fetchImpl);
  verifySnapshot(await readPullRequest(publication.pullRequestUrl));
}

export async function verifyPrMedia(
  media: PrMediaAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!media.url?.startsWith("https://github.com/user-attachments/assets/")) {
    throw new Error("Evidence is not a GitHub attachment.");
  }
  // Attachments become available after being referenced by a PR/comment. Their signed
  // download redirects authorize GET, not HEAD; verify the actual bytes after publication.
  const signal = AbortSignal.timeout(60_000);
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetchImpl(media.url, { method: "GET", signal });
    if (response.status !== 404 || attempt === 5) break;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** attempt, 8_000)));
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Published evidence could not be downloaded (${response.status}).`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > media.sizeBytes) {
        await reader.cancel();
        throw new Error("Published capture exceeds the supplied file size.");
      }
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== media.sizeBytes || hash.digest("hex") !== media.sha256) {
    throw new Error("Published capture differs from the supplied media.");
  }
}
