import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { Browser, Page } from "playwright";
import type { SelfTestDiagnostics, SelfTestMedia } from "../../../scripts/lib/selfTestEvidence.ts";

export function createSelfTestContext(
  browser: Browser,
  output: string | undefined,
  diagnostics: SelfTestDiagnostics,
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      if (output) await mkdir(output, { recursive: true });
      return browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(output
          ? { recordVideo: { dir: join(output, "raw"), size: { width: 1280, height: 800 } } }
          : {}),
      });
    }),
    (context) =>
      Effect.promise(async () => {
        await context.close();
        if (output) {
          await writeFile(join(output, "diagnostics.json"), JSON.stringify(diagnostics), {
            mode: 0o600,
          });
        }
      }),
  );
}

export function trackSelfTestConsole(
  page: Page,
  origin: string,
  diagnostics: { consoleErrors: number; expectedConsoleErrors: number },
  phase: () => "pairing" | "rejected-token" | "authenticated",
) {
  const websocketUrl = new URL("/ws", origin);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expected =
      message.args().length === 0 &&
      ((phase() === "rejected-token" &&
        message.location().url === `${origin}/api/auth/bootstrap` &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)") ||
        (phase() !== "authenticated" &&
          message.text() ===
            `WebSocket connection to '${websocketUrl}' failed: HTTP Authentication failed; no valid credentials available`));
    if (expected) diagnostics.expectedConsoleErrors += 1;
    else diagnostics.consoleErrors += 1;
  });
}

const CaptureProbe = Schema.Struct({
  width: Schema.Int,
  height: Schema.Int,
  durationSeconds: Schema.optional(Schema.Finite),
  sampledFrames: Schema.Int,
  distinctFrames: Schema.Int,
});
const decodeProbe = Schema.decodeUnknownSync(CaptureProbe);

async function inspectMedia(page: Page, bytes: Buffer, recording: boolean) {
  // Run in the browser to decode actual pixels, without a native codec dependency or network I/O.
  const result: unknown = await page.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "${recording ? "video/webm" : "image/png"}" }));
    const media = document.createElement("${recording ? "video" : "img"}");
    const ready = new Promise((resolve, reject) => {
      media.addEventListener("${recording ? "loadeddata" : "load"}", resolve, { once: true });
      media.addEventListener("error", () => reject(new Error("Media could not be decoded")), { once: true });
    });
    const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("Media decoding timed out")), 15000));
    try {
      media.src = url;
      await Promise.race([ready, deadline]);
      const width = ${recording ? "media.videoWidth" : "media.naturalWidth"};
      const height = ${recording ? "media.videoHeight" : "media.naturalHeight"};
      if (!width || !height) throw new Error("Capture has no pixels");
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 96;
      const context = canvas.getContext("2d");
      const frames = new Set();
      const checkPixels = () => {
        context.drawImage(media, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255, max = 0;
        for (let i = 0; i < data.length; i += 4) {
          const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        if (max - min < 12) throw new Error("Capture appears blank");
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          hash = Math.imul(hash ^ (data[i] >> 4), 16777619);
        }
        frames.add(hash);
      };
      ${
        recording
          ? `
      if (!Number.isFinite(media.duration)) {
        await Promise.race([new Promise(resolve => {
          media.addEventListener("seeked", resolve, { once: true });
          media.currentTime = 1e9;
        }), deadline]);
      }
      const durationSeconds = media.duration;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Recording has no finite duration");
      for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
        await Promise.race([new Promise(resolve => {
          media.addEventListener("seeked", resolve, { once: true });
          media.currentTime = durationSeconds * fraction;
        }), deadline]);
        checkPixels();
      }
      if (frames.size < 2) throw new Error("Recording appears frozen; no visual transition was captured");
      return { width, height, durationSeconds, sampledFrames: 6, distinctFrames: frames.size };`
          : `checkPixels(); return { width, height, sampledFrames: 1, distinctFrames: 1 };`
      }
    } finally {
      media.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  })()`);
  return decodeProbe(result);
}

export async function captureSelfTestScreenshot(
  page: Page,
  output: string,
  file = "authenticated.png",
): Promise<SelfTestMedia> {
  if (new URL(page.url()).hash || new URL(page.url()).searchParams.has("token")) {
    throw new Error("Refusing to capture a page with pairing credentials in its URL.");
  }
  await mkdir(output, { recursive: true });
  const bytes = await page.screenshot({ path: join(output, file), animations: "disabled" });
  const probe = await inspectMedia(page, bytes, false);
  return {
    kind: "screenshot",
    file,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...probe,
  };
}

export async function finishSelfTestCapture(
  browser: Browser,
  output: string,
  videoPath: string,
  screenshots: ReadonlyArray<SelfTestMedia>,
  scenarios: ReadonlyArray<string>,
  diagnostics: SelfTestDiagnostics,
): Promise<void> {
  const file = "pairing-reload.webm";
  await copyFile(videoPath, join(output, file));
  const bytes = await readFile(join(output, file));
  const verifier = await browser.newPage();
  try {
    const probe = await inspectMedia(verifier, bytes, true);
    const recording: SelfTestMedia = {
      kind: "recording",
      file,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...probe,
    };
    await writeFile(
      join(output, "capture.json"),
      JSON.stringify(
        {
          scenarios,
          media: [...screenshots, recording],
          diagnostics,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await verifier.close();
  }
}
