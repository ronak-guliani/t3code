import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  browserValidationFinalSnapshot,
  diagnosticsFromSnapshot,
  redactBrowserValidationText,
  validateBrowserValidationMedia,
} from "./BrowserValidationEvidence.ts";

const identity = {
  runId: "run-1",
  gateId: "browser-validation",
  executorId: "executor-1",
  threadId: "thread-1" as never,
  revision: "revision-1",
  environmentId: "environment-1" as never,
};

const png = PNG.sync.write(new PNG({ width: 2, height: 1 }));

describe("browser validation evidence", () => {
  it("redacts pairing and bearer credentials from diagnostics", () => {
    const value = redactBrowserValidationText(
      "https://example.test/pair#token=secret Bearer bearer-secret cookie=session-secret",
    );
    expect(value).not.toContain("secret");
    expect(value).toContain("[redacted]");
  });

  it("decodes, bounds, hashes, and identity-binds screenshots", async () => {
    const evidence = await validateBrowserValidationMedia({
      identity,
      media: {
        kind: "screenshot",
        mimeType: "image/png",
        bytes: png,
        width: 2,
        height: 1,
      },
    });
    expect(evidence).toMatchObject({
      kind: "screenshot",
      sizeBytes: png.length,
      width: 2,
      height: 1,
      runId: "run-1",
      gateId: "browser-validation",
      executorId: "executor-1",
      revision: "revision-1",
    });
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects undecodable or mismatched media", async () => {
    await expect(
      validateBrowserValidationMedia({
        identity,
        media: {
          kind: "screenshot",
          mimeType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
          width: 1,
          height: 1,
        },
      }),
    ).rejects.toThrow("outside the allowed bounds");

    await expect(
      validateBrowserValidationMedia({
        identity,
        media: {
          kind: "screenshot",
          mimeType: "image/png",
          bytes: png,
          width: 1,
          height: 1,
        },
      }),
    ).rejects.toThrow("dimensions do not match");
  });

  it("keeps snapshot diagnostics bounded and URL-safe", () => {
    const snapshot = {
      url: "https://example.test/app?token=secret#private",
      title: "Application",
      loading: false,
      visibleText: "Signed in",
      interactiveElements: [],
      accessibilityTree: null,
      consoleEntries: [
        {
          level: "error",
          text: "Bearer secret",
          timestamp: "now",
        },
      ],
      networkEntries: [
        {
          url: "https://example.test/api?credential=secret",
          method: "GET",
          status: 500,
          failed: true,
          timestamp: "now",
        },
      ],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png" as const,
        data: png.toString("base64"),
        width: 2,
        height: 1,
      },
    };
    const diagnostics = diagnosticsFromSnapshot(snapshot);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    expect(browserValidationFinalSnapshot(snapshot).url).toBe("https://example.test/app");
  });

  it("preserves visible text beyond the diagnostic message bound", () => {
    const visibleText = "visible ".repeat(300);
    const snapshot = {
      url: "https://example.test/app",
      title: "Application",
      loading: false,
      visibleText,
      interactiveElements: [],
      accessibilityTree: null,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png" as const,
        data: png.toString("base64"),
        width: 2,
        height: 1,
      },
    };
    expect(browserValidationFinalSnapshot(snapshot).visibleText).toBe(visibleText);
  });
});
