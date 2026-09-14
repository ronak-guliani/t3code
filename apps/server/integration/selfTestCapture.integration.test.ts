import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectSelfTestMedia } from "./selfTestCapture.ts";

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
  });

  it.each(["white", "static", "navigation"])("accepts a decodable %s recording", async (kind) => {
    // Encoding real frames requires elapsed time; no application state is polled or mocked.
    const encoded: unknown = await page.evaluate(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 200;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(0);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
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
        const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
        return btoa(String.fromCharCode(...bytes));
      } finally {
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach(track => track.stop());
      }
    })()`);
    if (typeof encoded !== "string") throw new Error("Recording fixture did not produce bytes.");
    const result = await inspectSelfTestMedia(page, Buffer.from(encoded, "base64"), true);
    expect(result).toMatchObject({ width: 320, height: 200 });
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("distinctFrames");
  });

  it.each([false, true])("rejects corrupt media (recording: %s)", async (recording) => {
    await expect(inspectSelfTestMedia(page, Buffer.from("not media"), recording)).rejects.toThrow(
      "Media could not be decoded",
    );
  });
});
