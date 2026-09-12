import { createHash } from "node:crypto";
import type { SelfTestManifest, SelfTestMedia } from "./selfTestEvidence.ts";

interface PublicationSnapshot {
  readonly head: { readonly sha: string };
  readonly body: string | null;
}

export async function verifySelfTestPublication(
  manifest: SelfTestManifest,
  readPullRequest: (url: string) => Promise<PublicationSnapshot>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!manifest.publication) throw new Error("Evidence has not been attached to a PR.");
  const verifySnapshot = (pr: PublicationSnapshot) => {
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
    }
  };
  verifySnapshot(await readPullRequest(manifest.publication.pullRequestUrl));
  for (const media of manifest.media) await verifySelfTestMedia(media, fetchImpl);
  verifySnapshot(await readPullRequest(manifest.publication.pullRequestUrl));
}

export async function verifySelfTestMedia(
  media: SelfTestMedia,
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
        throw new Error("Published evidence exceeds the validated file size.");
      }
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== media.sizeBytes || hash.digest("hex") !== media.sha256) {
    throw new Error("Published evidence differs from the validated media.");
  }
}
