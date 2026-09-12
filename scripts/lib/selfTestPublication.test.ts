import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySelfTestMedia } from "./selfTestPublication.ts";
import type { SelfTestMedia } from "./selfTestEvidence.ts";

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
