import { createHash } from "node:crypto";
import { PNG } from "pngjs";

import type {
  BrowserValidationDiagnostics,
  BrowserValidationDiagnostic,
  BrowserValidationFinalSnapshot,
  BrowserValidationIdentity,
  BrowserValidationMediaEvidence,
  BrowserValidationMediaRequirement,
  BrowserValidationAppState,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";

const MAX_DIAGNOSTICS = 40;
const MAX_DIAGNOSTIC_LENGTH = 1_000;
const MAX_VISIBLE_TEXT_LENGTH = 12_000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_EDGE = 3_840;

const REDACTED = "[redacted]";
const SECRET_QUERY =
  /([?#&](?:token|access_token|credential|authorization|password|secret|session)=)[^&#\s]+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const PAIRING_HASH = /(\/pair#token=)[^/\s]+/gi;

export class BrowserValidationEvidenceError extends Error {
  readonly _tag = "BrowserValidationEvidenceError";
}

export interface BrowserValidationRecordingDecoder {
  readonly decode: (input: { readonly bytes: Uint8Array; readonly mimeType: string }) => Promise<{
    readonly width: number;
    readonly height: number;
    readonly durationSeconds: number;
  }>;
}

export interface BrowserValidationMediaPersistence {
  readonly persist: (input: {
    readonly identity: BrowserValidationIdentity;
    readonly kind: BrowserValidationMediaEvidence["kind"];
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }) => Promise<string>;
}

export interface BrowserValidationMediaInput {
  readonly kind: BrowserValidationMediaEvidence["kind"];
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

export const redactBrowserValidationText = (
  value: string,
  maxLength = MAX_DIAGNOSTIC_LENGTH,
): string =>
  value
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(PAIRING_HASH, `$1${REDACTED}`)
    .replace(/(cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*[^\s;,]+/gi, `$1: ${REDACTED}`)
    .slice(0, maxLength);

export const sanitizeBrowserValidationUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactBrowserValidationText(value).split(/[?#]/, 1)[0] ?? REDACTED;
  }
};

const diagnostic = (
  kind: BrowserValidationDiagnostic["kind"],
  message: string,
): BrowserValidationDiagnostic => ({
  kind,
  message: redactBrowserValidationText(message).trim() || REDACTED,
});

export const sanitizeConsoleDiagnostics = (
  entries: ReadonlyArray<PreviewAutomationConsoleEntry>,
): ReadonlyArray<BrowserValidationDiagnostic> =>
  entries.slice(-MAX_DIAGNOSTICS).map((entry) => {
    const source = entry.source ? ` (${redactBrowserValidationText(entry.source)})` : "";
    return diagnostic("console", `${entry.level}${source}: ${entry.text}`);
  });

export const sanitizeNetworkDiagnostics = (
  entries: ReadonlyArray<PreviewAutomationNetworkEntry>,
): ReadonlyArray<BrowserValidationDiagnostic> =>
  entries.slice(-MAX_DIAGNOSTICS).map((entry) => {
    const detail = entry.errorText ? `: ${entry.errorText}` : "";
    return diagnostic(
      "network",
      `${entry.method} ${sanitizeBrowserValidationUrl(entry.url)} ${
        entry.status === null ? "failed" : String(entry.status)
      }${detail}`,
    );
  });

export const diagnosticsFromSnapshot = (
  snapshot: PreviewAutomationSnapshot | null,
): BrowserValidationDiagnostics => ({
  console: snapshot ? [...sanitizeConsoleDiagnostics(snapshot.consoleEntries)] : [],
  network: snapshot ? [...sanitizeNetworkDiagnostics(snapshot.networkEntries)] : [],
});

export const browserValidationFinalSnapshot = (
  snapshot: PreviewAutomationSnapshot,
): BrowserValidationFinalSnapshot => ({
  ...(snapshot.tabId === undefined ? {} : { tabId: snapshot.tabId }),
  origin: (() => {
    try {
      return new URL(snapshot.url).origin;
    } catch {
      return null;
    }
  })(),
  url: sanitizeBrowserValidationUrl(snapshot.url),
  title: redactBrowserValidationText(snapshot.title).slice(0, 512),
  visibleText: redactBrowserValidationText(snapshot.visibleText, MAX_VISIBLE_TEXT_LENGTH),
  loading: snapshot.loading,
});

export const browserValidationAppState = (
  snapshot: PreviewAutomationSnapshot,
  authenticated: boolean,
): BrowserValidationAppState => {
  let origin: string | null = null;
  let path: string | null = null;
  try {
    const url = new URL(snapshot.url);
    origin = url.origin;
    path = url.pathname;
  } catch {
    // The final snapshot remains diagnostic-only when its URL is malformed.
  }
  return { authenticated, origin, path };
};

const decodePng = async (
  bytes: Uint8Array,
  width: number | undefined,
  height: number | undefined,
): Promise<{ readonly width: number; readonly height: number }> => {
  if (bytes.length < 45 || bytes.length > MAX_MEDIA_BYTES) {
    throw new BrowserValidationEvidenceError("Screenshot bytes are outside the allowed bounds.");
  }
  const image = await new Promise<PNG>((resolve, reject) => {
    const decoder = new PNG({ checkCRC: true });
    decoder.parse(Buffer.from(bytes), (error, parsed) => {
      if (error || !parsed) {
        reject(new BrowserValidationEvidenceError("Screenshot could not be decoded."));
      } else {
        resolve(parsed);
      }
    });
  });
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > MAX_MEDIA_EDGE ||
    image.height > MAX_MEDIA_EDGE ||
    image.data.length !== image.width * image.height * 4 ||
    (width !== undefined && width !== image.width) ||
    (height !== undefined && height !== image.height)
  ) {
    throw new BrowserValidationEvidenceError("Screenshot dimensions do not match decoded pixels.");
  }
  return { width: image.width, height: image.height };
};

const validateRecordingContainer = (mimeType: string, bytes: Uint8Array): void => {
  const isWebm =
    mimeType.includes("webm") &&
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;
  const isMp4 =
    mimeType.includes("mp4") &&
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp";
  if (!isWebm && !isMp4) {
    throw new BrowserValidationEvidenceError("Recording container does not match its MIME type.");
  }
};

export const validateBrowserValidationMedia = async (input: {
  readonly identity: BrowserValidationIdentity;
  readonly media: BrowserValidationMediaInput;
  readonly decoder?: BrowserValidationRecordingDecoder;
  readonly persistence?: BrowserValidationMediaPersistence;
}): Promise<BrowserValidationMediaEvidence> => {
  const { identity, media } = input;
  if (media.bytes.length <= 0 || media.bytes.length > MAX_MEDIA_BYTES) {
    throw new BrowserValidationEvidenceError("Media bytes are outside the allowed bounds.");
  }
  const sha256 = createHash("sha256").update(media.bytes).digest("hex");
  let width = media.width ?? 0;
  let height = media.height ?? 0;
  let durationSeconds = media.durationSeconds;

  if (media.kind === "screenshot") {
    if (media.mimeType !== "image/png") {
      throw new BrowserValidationEvidenceError("Screenshot MIME type must be image/png.");
    }
    const decoded = await decodePng(media.bytes, media.width, media.height);
    width = decoded.width;
    height = decoded.height;
  } else {
    validateRecordingContainer(media.mimeType, media.bytes);
    if (!input.decoder) {
      throw new BrowserValidationEvidenceError("Recording decoder is unavailable.");
    }
    const decoded = await input.decoder.decode({
      bytes: media.bytes,
      mimeType: media.mimeType,
    });
    width = decoded.width;
    height = decoded.height;
    durationSeconds = decoded.durationSeconds;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_MEDIA_EDGE ||
      height > MAX_MEDIA_EDGE ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new BrowserValidationEvidenceError("Recording decoder returned invalid metadata.");
    }
  }

  const persistedPath = input.persistence
    ? await input.persistence.persist({
        identity,
        kind: media.kind,
        mimeType: media.mimeType,
        bytes: media.bytes,
        sha256,
      })
    : undefined;

  return {
    kind: media.kind,
    mimeType: media.mimeType,
    sizeBytes: media.bytes.length,
    width,
    height,
    sha256,
    revision: identity.revision,
    runId: identity.runId,
    gateId: identity.gateId,
    executorId: identity.executorId,
    environmentId: identity.environmentId,
    ...(persistedPath === undefined ? {} : { persistedPath }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
};

export const mediaRequirementsSatisfied = (
  requirements: ReadonlyArray<BrowserValidationMediaRequirement>,
  media: ReadonlyArray<BrowserValidationMediaEvidence>,
): boolean =>
  requirements
    .filter((requirement) => requirement.required)
    .every((requirement) => media.some((candidate) => candidate.kind === requirement.kind));

export const diagnosticFromError = (
  kind: BrowserValidationDiagnostic["kind"],
  error: unknown,
): BrowserValidationDiagnostic =>
  diagnostic(kind, error instanceof Error ? error.message : "Browser validation operation failed.");
