import { Schema } from "effect";
import type { Page } from "playwright";

export const MediaContentType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "video/webm",
  "video/mp4",
]);
export type MediaContentType = typeof MediaContentType.Type;

const CaptureProbe = Schema.Struct({
  width: Schema.Int,
  height: Schema.Int,
  durationSeconds: Schema.optional(Schema.Finite),
});
const decodeProbe = Schema.decodeUnknownSync(CaptureProbe);

export async function inspectMediaIntegrity(
  page: Page,
  bytes: Buffer,
  contentType: MediaContentType,
) {
  const matchesFormat =
    contentType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : contentType === "image/jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : contentType === "video/webm"
          ? bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
          : bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (!matchesFormat)
    throw new Error(`Capture bytes do not match the declared ${contentType} format.`);

  const recording = contentType.startsWith("video/");
  // Decode the file, not its meaning: white/loading or static frames are valid media.
  const result: unknown = await page.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(contentType)} }));
    const media = document.createElement("${recording ? "video" : "img"}");
    const ready = new Promise(resolve => {
      media.addEventListener("${recording ? "loadeddata" : "load"}", resolve, { once: true });
    });
    const failed = new Promise((_, reject) => {
      media.addEventListener("error", () => reject(new Error("Media could not be decoded")), { once: true });
    });
    let timeoutId;
    const deadline = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Media decoding timed out")), 15000);
    });
    try {
      media.src = url;
      await Promise.race([ready, failed, deadline]);
      const width = ${recording ? "media.videoWidth" : "media.naturalWidth"};
      const height = ${recording ? "media.videoHeight" : "media.naturalHeight"};
      if (!width || !height) throw new Error("Capture has no pixels");
      ${
        recording
          ? `
      if (!Number.isFinite(media.duration)) {
        await Promise.race([new Promise(resolve => {
          media.addEventListener("seeked", resolve, { once: true });
          media.currentTime = 1e9;
        }), failed, deadline]);
      }
      const durationSeconds = media.duration;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Recording has no finite duration");
      for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
        await Promise.race([new Promise(resolve => {
          media.addEventListener("seeked", resolve, { once: true });
          media.currentTime = durationSeconds * fraction;
        }), failed, deadline]);
      }
      return { width, height, durationSeconds };`
          : `return { width, height };`
      }
    } finally {
      clearTimeout(timeoutId);
      media.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  })()`);
  return decodeProbe(result);
}
