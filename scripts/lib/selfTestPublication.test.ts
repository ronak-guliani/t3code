import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySelfTestMedia, verifySelfTestPublication } from "./selfTestPublication.ts";
import type { SelfTestManifest, SelfTestMedia } from "./selfTestEvidence.ts";

const bytes = "validated image";
const media: SelfTestMedia = {
  kind: "screenshot",
  file: "image.png",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: Buffer.byteLength(bytes),
  width: 1,
  height: 1,
  sampledFrames: 1,
  distinctFrames: 1,
  url: "https://github.com/user-attachments/assets/test",
};
const manifest: SelfTestManifest = {
  version: 1,
  runId: "run",
  revision: { commit: "tested-head", contentHash: "clean" },
  status: "passed",
  startedAt: "2026-09-12T00:00:00Z",
  completedAt: "2026-09-12T00:01:00Z",
  command: "pnpm test:direct-connect-smoke",
  exitCode: 0,
  scenarios: ["Pairing"],
  diagnostics: { consoleErrors: 0, expectedConsoleErrors: 0, pageErrors: 0, failedRequests: 0 },
  media: [media, { ...media, url: `${media.url}-second` }],
  publication: { pullRequestUrl: "https://github.com/owner/repo/pull/1" },
};

describe("published PR state verification", () => {
  const snapshot = {
    head: { sha: manifest.revision.commit },
    body: manifest.media.map((item) => item.url).join("\n"),
  };

  it("checks the PR before and after all media downloads", async () => {
    const calls: string[] = [];
    const read = vi.fn(async () => {
      calls.push("read");
      return snapshot;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("download");
      return new Response(bytes);
    });
    await verifySelfTestPublication(manifest, read, fetchImpl);
    expect(calls).toEqual(["read", "download", "download", "read"]);
  });

  it.each([
    { changed: { ...snapshot, head: { sha: "new-head" } }, error: "PR head changed" },
    { changed: { ...snapshot, body: media.url! }, error: "missing from the PR" },
  ])("rejects $error during media downloads", async ({ changed, error }) => {
    const read = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
    await expect(verifySelfTestPublication(manifest, read, fetchImpl)).rejects.toThrow(error);
    expect(read).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not download media when the initial PR head is stale", async () => {
    const read = vi.fn().mockResolvedValue({ ...snapshot, head: { sha: "new-head" } });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifySelfTestPublication(manifest, read, fetchImpl)).rejects.toThrow("stale");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("published self-test media verification", () => {
  afterEach(() => vi.useRealTimers());

  it("downloads with GET because signed attachment redirects reject HEAD", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    await verifySelfTestMedia(media, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(media.url, expect.objectContaining({ method: "GET" }));
  });
  it("does not accept an unassociated or inaccessible attachment", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not found", { status: 404 }));
    const assertion = expect(verifySelfTestMedia(media, fetchImpl)).rejects.toThrow(
      "could not be downloaded (404)",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
  it("retries attachment propagation without changing the URL or skipping byte verification", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(bytes));
    const verification = verifySelfTestMedia(media, fetchImpl);
    await vi.runAllTimersAsync();
    await verification;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => url === media.url)).toBe(true);
  });
  it("does not retry authorization failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    await expect(verifySelfTestMedia(media, fetchImpl)).rejects.toThrow(
      "could not be downloaded (403)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a success-shaped HTML response and altered bytes", async () => {
    for (const body of ["<html>login</html>", "wrong"]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(verifySelfTestMedia(media, fetchImpl)).rejects.toThrow(/validated/);
    }
  });
  it("does not fetch arbitrary URLs from a manifest", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      verifySelfTestMedia({ ...media, url: "http://localhost/private" }, fetchImpl),
    ).rejects.toThrow("GitHub attachment");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
