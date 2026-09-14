import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectSelfTestMedia } from "./selfTestCapture.ts";
import { inspectMediaIntegrity } from "../../../scripts/lib/mediaIntegrity.ts";
import { prMediaAsset } from "../../../scripts/lib/prMedia.ts";

describe("capture file integrity, not visual correctness", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("decodes a white screenshot instead of inventing a UI failure", async () => {
    await page.setContent("<html><body style='background:white'></body></html>");
    const bytes = await page.screenshot();
    expect(await inspectSelfTestMedia(page, bytes, false)).toMatchObject({
      width: 1280,
      height: 720,
    });
    expect(await prMediaAsset(page, "white.png", bytes)).toMatchObject({
      contentType: "image/png",
    });
    await expect(prMediaAsset(page, "truncated.png", bytes.subarray(0, 32))).rejects.toThrow(
      "Media could not be decoded",
    );
    await expect(prMediaAsset(page, "renamed.jpg", bytes)).rejects.toThrow("declared image/jpeg");
  });

  it("decodes JPEGs and rejects renamed, empty, and unsupported files", async () => {
    const bytes = await page.screenshot({ type: "jpeg" });
    for (const file of ["before.JPG", "after.jpeg"]) {
      expect(await prMediaAsset(page, file, bytes)).toMatchObject({ contentType: "image/jpeg" });
    }
    await expect(prMediaAsset(page, "truncated.jpg", bytes.subarray(0, 32))).rejects.toThrow(
      "Media could not be decoded",
    );
    await expect(prMediaAsset(page, "renamed.png", bytes)).rejects.toThrow("declared image/png");
    await expect(prMediaAsset(page, "empty.png", Buffer.alloc(0))).rejects.toThrow("empty");
    await expect(prMediaAsset(page, "secret.txt", bytes)).rejects.toThrow(
      "PNG, JPEG, WebM, or MP4",
    );
  });

  it.each([
    { kind: "white", format: "webm" },
    { kind: "static", format: "webm" },
    { kind: "navigation", format: "webm" },
    { kind: "white", format: "mp4" },
    { kind: "static", format: "mp4" },
    { kind: "navigation", format: "mp4" },
  ])("accepts a decodable $kind $format recording", async ({ kind, format }) => {
    const contentType = format === "mp4" ? "video/mp4" : "video/webm";
    const recordingType = format === "mp4" ? "video/mp4;codecs=avc1.42E01E" : "video/webm";
    // Encoding real frames requires elapsed time; no application state is polled or mocked.
    const encoded: unknown = await page.evaluate(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 200;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(0);
      const recorder = new MediaRecorder(stream, { mimeType: ${JSON.stringify(recordingType)} });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => recorder.onstop = resolve);
      recorder.start();
      try {
        for (let frame = 0; frame < 30; frame++) {
          context.fillStyle = "white";
          context.fillRect(0, 0, 320, 200);
          if (${JSON.stringify(kind)} !== "white" && !(${JSON.stringify(kind)} === "navigation" && frame === 22)) {
            context.fillStyle = "black";
            context.fillRect(${JSON.stringify(kind)} === "navigation" ? frame * 6 : 20, 30, 100, 100);
          }
          stream.getVideoTracks()[0].requestFrame();
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        recorder.stop();
        await stopped;
        const bytes = new Uint8Array(await new Blob(chunks, { type: ${JSON.stringify(contentType)} }).arrayBuffer());
        return btoa(String.fromCharCode(...bytes));
      } finally {
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach(track => track.stop());
      }
    })()`);
    if (typeof encoded !== "string") throw new Error("Recording fixture did not produce bytes.");
    const bytes = Buffer.from(encoded, "base64");
    const result = await inspectMediaIntegrity(page, bytes, contentType);
    expect(result).toMatchObject({ width: 320, height: 200 });
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("distinctFrames");
    expect(await prMediaAsset(page, `capture.${format}`, bytes)).toMatchObject({ contentType });
    await expect(prMediaAsset(page, `truncated.${format}`, bytes.subarray(0, 32))).rejects.toThrow(
      "Media could not be decoded",
    );
    const wrongExtension = format === "mp4" ? "webm" : "mp4";
    await expect(prMediaAsset(page, `renamed.${wrongExtension}`, bytes)).rejects.toThrow(
      "declared",
    );
  });

  it.each([false, true])("rejects corrupt media (recording: %s)", async (recording) => {
    await expect(inspectSelfTestMedia(page, Buffer.from("not media"), recording)).rejects.toThrow(
      "declared",
    );
  });
  it.each(["png", "jpg", "webm", "mp4"])("rejects text renamed as .%s", async (extension) => {
    await expect(prMediaAsset(page, `text.${extension}`, Buffer.from("not media"))).rejects.toThrow(
      "declared",
    );
  });
});
