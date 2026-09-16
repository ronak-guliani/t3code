/**
 * PreviewEvidence - Server-side persistence for browser evidence.
 *
 * Screenshots arrive as bytes in snapshot results and finished recordings can
 * be pulled from the browser host over the automation channel, so the server
 * can store agent-readable copies even when the browser host runs on another
 * machine. Files live outside disposable server state and the repository, and
 * are picked up out-of-band (e.g. `pnpm pr:media`).
 *
 * @module PreviewEvidence
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Explicit override for the browser evidence directory (tests, custom homes). */
export const BROWSER_EVIDENCE_DIR_ENV = "T3CODE_BROWSER_EVIDENCE_DIR";

export const resolveBrowserEvidenceDir = (explicit?: string): string =>
  explicit ?? process.env[BROWSER_EVIDENCE_DIR_ENV] ?? join(tmpdir(), "t3code-browser-evidence");

const sanitizePrefix = (prefix: string): string => {
  const cleaned = prefix.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : "evidence";
};

export const saveBrowserEvidenceFile = async (input: {
  readonly directory?: string | undefined;
  readonly prefix: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
}): Promise<string> => {
  const directory = resolveBrowserEvidenceDir(input.directory);
  const name = `${sanitizePrefix(input.prefix)}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.${input.extension}`;
  const path = join(directory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path, input.bytes);
  return path;
};

/** Map a recording MIME type to a file extension for the transferred copy. */
export const recordingExtensionForMimeType = (mimeType: string): string =>
  mimeType.includes("mp4") ? "mp4" : "webm";
