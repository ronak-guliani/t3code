import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  installManagedCopilot,
  parseSha256Sums,
  selectCopilotReleaseAsset,
  verifySha256,
} from "./copilotManagedInstaller.ts";

describe("copilotManagedInstaller", () => {
  it("selects the release asset for the current platform shape", () => {
    const asset = selectCopilotReleaseAsset({
      platform: "darwin",
      arch: "arm64",
      release: {
        assets: [
          { name: "copilot-linux-x64.tar.gz", browser_download_url: "https://example/linux" },
          { name: "copilot-darwin-arm64.tar.gz", browser_download_url: "https://example/mac" },
          { name: "SHA256SUMS.txt", browser_download_url: "https://example/sums" },
        ],
      },
    });

    expect(asset.name).toBe("copilot-darwin-arm64.tar.gz");
  });

  it("parses and verifies SHA256SUMS entries", () => {
    const bytes = new TextEncoder().encode("archive");
    const expected = createHash("sha256").update(bytes).digest("hex");
    const sums = parseSha256Sums(`${expected}  copilot-linux-x64.tar.gz\n`);

    expect(sums.get("copilot-linux-x64.tar.gz")).toBe(expected);
    expect(() => verifySha256({ bytes, expectedHex: expected })).not.toThrow();
    expect(() => verifySha256({ bytes, expectedHex: "0".repeat(64) })).toThrow(/Checksum mismatch/);
  });

  it("downloads, verifies, writes, and extracts a managed install", async () => {
    const archive = new TextEncoder().encode("archive");
    const checksum = createHash("sha256").update(archive).digest("hex");
    const written = new Map<string, Uint8Array>();
    const madeDirs: string[] = [];

    const result = await installManagedCopilot({
      stateDir: "/state",
      platform: "linux",
      arch: "x64",
      fetchRelease: async () => ({
        tag_name: "v1.2.3",
        assets: [
          {
            name: "copilot-linux-x64.tar.gz",
            browser_download_url: "https://example/archive",
          },
          {
            name: "SHA256SUMS.txt",
            browser_download_url: "https://example/sums",
          },
        ],
      }),
      fetchBytes: async (url) =>
        url.endsWith("/sums")
          ? new TextEncoder().encode(`${checksum}  copilot-linux-x64.tar.gz\n`)
          : archive,
      makeDirectory: async (path) => {
        madeDirs.push(path);
      },
      writeFile: async (path, bytes) => {
        written.set(path, bytes);
      },
      extractArchive: async ({ archivePath, destinationDir, binaryName }) =>
        join(destinationDir, basename(archivePath), binaryName),
    });

    expect(result.version).toBe("v1.2.3");
    expect(result.assetName).toBe("copilot-linux-x64.tar.gz");
    expect(written.get(result.archivePath)).toBe(archive);
    expect(madeDirs).toContain("/state/providers/copilot/managed/downloads");
  });
});
