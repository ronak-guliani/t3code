import { isWindowsAbsolutePath } from "./path.ts";

const PATH_FIELD_KEYS = [
  "path",
  "filePath",
  "relativePath",
  "filename",
  "newPath",
  "oldPath",
] as const;
const NESTED_FIELD_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

// String fields where providers (notably Codex/Copilot apply_patch) embed
// patch text containing the actual changed file paths.
const EMBEDDED_PATCH_TEXT_FIELD_KEYS = ["rawInput", "patch"] as const;

// `*** Add File: path`, `*** Update File: path`, `*** Delete File: path`,
// `*** Move File: oldPath -> newPath`, `*** Rename File: oldPath -> newPath`.
// Apply_patch headers preserve paths verbatim (absolute or relative as the
// caller wrote them), unlike unified diff `--- a/<path>` which strips the
// leading `/` from absolute paths via the `a/`/`b/` prefix convention.
const APPLY_PATCH_HEADER_REGEX =
  /^\*\*\*\s+(?:Add|Update|Delete|Move|Rename)\s+File:\s+(.+?)(?:\s+->\s+(.+))?\s*$/gmu;

function extractPathsFromEmbeddedPatchText(value: string): string[] {
  if (!value.includes("*** ")) {
    return [];
  }

  const paths: string[] = [];
  for (const match of value.matchAll(APPLY_PATCH_HEADER_REGEX)) {
    if (match[1]) paths.push(match[1]);
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_PATHS = 500;
const FIRST_CONTROL_CHARACTER_CODE = 0x00;
const LAST_CONTROL_CHARACTER_CODE = 0x1f;

export interface ChangedFilePathExtractionOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxPaths?: number;
}

export interface ChangedFilePathNormalizationOptions {
  readonly cwd?: string | undefined;
}

export interface InlineUnifiedDiffPreviewOptions {
  readonly maxLines?: number;
}

export interface InlineUnifiedDiffPreview {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function hasUnsafeGitPathspecPrefix(value: string): boolean {
  return value.startsWith(":");
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (
      code !== undefined &&
      code >= FIRST_CONTROL_CHARACTER_CODE &&
      code <= LAST_CONTROL_CHARACTER_CODE
    ) {
      return true;
    }
  }
  return false;
}

function isUnsafeRelativePath(value: string): boolean {
  return value === ".." || value.startsWith("../");
}

function isPosixAbsolute(value: string): boolean {
  return value.startsWith("/");
}

function normalizePosixPath(value: string): string {
  const segments = value.split("/");
  const stack: string[] = [];
  const isAbsolute = value.startsWith("/");
  const hasTrailingSlash = value.length > 1 && value.endsWith("/");

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }

  let result = stack.join("/");
  if (isAbsolute) {
    result = `/${result}`;
  } else if (result.length === 0) {
    result = ".";
  }
  if (hasTrailingSlash && !result.endsWith("/")) {
    result = `${result}/`;
  }
  return result;
}

function posixRelative(from: string, to: string): string {
  const fromSegments = from.split("/").filter((segment) => segment.length > 0);
  const toSegments = to.split("/").filter((segment) => segment.length > 0);

  let commonLength = 0;
  while (
    commonLength < fromSegments.length &&
    commonLength < toSegments.length &&
    fromSegments[commonLength] === toSegments[commonLength]
  ) {
    commonLength += 1;
  }

  const upSegments = new Array(fromSegments.length - commonLength).fill("..");
  const downSegments = toSegments.slice(commonLength);
  return [...upSegments, ...downSegments].join("/");
}

function normalizeRelativePath(value: string): string | null {
  const normalized = normalizePosixPath(normalizeSeparators(value)).replace(/^\.\/+/u, "");
  if (normalized.length === 0 || normalized === ".") {
    return null;
  }
  if (isUnsafeRelativePath(normalized)) {
    return null;
  }
  return normalized;
}

function stripWindowsDrivePrefix(value: string): { drive: string; rest: string } | null {
  if (/^[a-zA-Z]:[/\\]/.test(value)) {
    return { drive: value.slice(0, 2).toLowerCase(), rest: value.slice(2) };
  }
  return null;
}

function normalizeAbsolutePath(value: string, cwd: string | undefined): string | null {
  if (!cwd) {
    return null;
  }
  const valueDrive = stripWindowsDrivePrefix(value);
  const cwdDrive = stripWindowsDrivePrefix(cwd);
  // Windows absolute path: require matching drive letters (case-insensitive)
  // and compute relative path using forward-slash-normalized segments.
  if (valueDrive || cwdDrive) {
    if (!valueDrive || !cwdDrive || valueDrive.drive !== cwdDrive.drive) {
      return null;
    }
    const normalizedCwd = normalizePosixPath(normalizeSeparators(cwdDrive.rest));
    const normalizedValue = normalizePosixPath(normalizeSeparators(valueDrive.rest));
    const relative = posixRelative(normalizedCwd, normalizedValue);
    if (relative.length === 0 || relative.startsWith("..") || isPosixAbsolute(relative)) {
      return null;
    }
    return normalizeRelativePath(relative);
  }
  const normalizedCwd = normalizePosixPath(normalizeSeparators(cwd));
  const normalizedValue = normalizePosixPath(normalizeSeparators(value));
  const relative = posixRelative(normalizedCwd, normalizedValue);
  if (relative.length === 0 || relative.startsWith("..") || isPosixAbsolute(relative)) {
    return null;
  }
  return normalizeRelativePath(relative);
}

export function normalizeChangedFilePath(
  value: string,
  options: ChangedFilePathNormalizationOptions = {},
): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || hasControlCharacter(trimmed)) {
    return null;
  }

  const nfc = trimmed.normalize("NFC");
  if (hasUnsafeGitPathspecPrefix(nfc)) {
    return null;
  }

  if (isPosixAbsolute(nfc) || isWindowsAbsolutePath(nfc)) {
    return normalizeAbsolutePath(nfc, options.cwd);
  }

  return normalizeRelativePath(nfc);
}

export function extractChangedFilePathCandidatesFromToolPayload(
  payload: unknown,
  options: ChangedFilePathExtractionOptions = {},
): string[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const candidates: string[] = [];
  const seen = new Set<string>();
  let visitedNodes = 0;

  const pushCandidate = (value: unknown): boolean => {
    const candidate = asTrimmedString(value);
    if (!candidate) {
      return false;
    }
    const normalizedForDeduplication = candidate.normalize("NFC");
    if (seen.has(normalizedForDeduplication)) {
      return false;
    }
    seen.add(normalizedForDeduplication);
    candidates.push(normalizedForDeduplication);
    return candidates.length >= maxPaths;
  };

  const collect = (value: unknown, depth: number): void => {
    if (depth > maxDepth || candidates.length >= maxPaths || visitedNodes >= maxNodes) {
      return;
    }
    visitedNodes += 1;

    if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry, depth + 1);
        if (candidates.length >= maxPaths || visitedNodes >= maxNodes) {
          return;
        }
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    for (const key of PATH_FIELD_KEYS) {
      if (pushCandidate(record[key])) {
        return;
      }
    }

    for (const key of EMBEDDED_PATCH_TEXT_FIELD_KEYS) {
      const fieldValue = record[key];
      if (typeof fieldValue !== "string") {
        continue;
      }
      for (const embeddedPath of extractPathsFromEmbeddedPatchText(fieldValue)) {
        if (pushCandidate(embeddedPath)) {
          return;
        }
      }
    }

    for (const nestedKey of NESTED_FIELD_KEYS) {
      if (!(nestedKey in record)) {
        continue;
      }
      collect(record[nestedKey], depth + 1);
      if (candidates.length >= maxPaths || visitedNodes >= maxNodes) {
        return;
      }
    }
  };

  collect(payload, 0);
  return candidates;
}

export function extractNormalizedChangedFilePathsFromToolPayload(
  payload: unknown,
  options: ChangedFilePathExtractionOptions & ChangedFilePathNormalizationOptions = {},
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of extractChangedFilePathCandidatesFromToolPayload(payload, options)) {
    const normalized = normalizeChangedFilePath(candidate, options);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

function isUnifiedDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line === "\\ No newline at end of file"
  );
}

function parseDiffGitPath(line: string): string | null {
  if (!line.startsWith("diff --git ")) {
    return null;
  }
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
  if (!match) {
    return null;
  }
  return match[2] ?? match[1] ?? null;
}

export function buildInlineUnifiedDiffPreview(
  diff: string,
  options: InlineUnifiedDiffPreviewOptions = {},
): InlineUnifiedDiffPreview | null {
  const maxLines = options.maxLines ?? 80;
  const visibleLines: Array<string> = [];

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    const filePath = parseDiffGitPath(line);
    if (filePath) {
      visibleLines.push(`File: ${filePath}`);
      continue;
    }
    if (isUnifiedDiffMetadataLine(line)) {
      continue;
    }
    visibleLines.push(line);
  }

  if (visibleLines.length === 0) {
    return null;
  }

  return {
    lines: visibleLines.slice(0, maxLines),
    truncated: visibleLines.length > maxLines,
  };
}
