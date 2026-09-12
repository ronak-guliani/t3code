import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  it("downloads with GET because signed attachment redirects reject HEAD", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    await verifySelfTestMedia(media, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(media.url, expect.objectContaining({ method: "GET" }));
  });
  it("does not accept an unassociated or inaccessible attachment", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(verifySelfTestMedia(media, fetchImpl)).rejects.toThrow(
      "could not be downloaded (404)",
    );
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
