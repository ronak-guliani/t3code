import type { ReviewDiffFile, ReviewDiffFileSize, ReviewDiffMetadata } from "@t3tools/contracts";

const MAX_DIFF_SIZE = 4_375_000;
const MAX_REASONABLE_DIFF_SIZE = 2_187_500;
const MAX_CHARACTERS_PER_LINE = 5_000;
const DIFF_LINE_RENDER_LIMIT = 10_000;
const DELETION_LINE_RENDER_LIMIT = 8_000;
const BIDI_CHARS = /[\u202A-\u202E\u2066-\u2069]/u;

const EMPTY_METADATA: ReviewDiffMetadata = {
  filesChanged: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  largeFiles: 0,
  unrenderableFiles: 0,
};

function stripGitPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function parseQuotedGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseHeaderPath(section: string): { path: string; previousPath: string | null } | null {
  const renameFrom = section.match(/^rename from (.+)$/m)?.[1];
  const renameTo = section.match(/^rename to (.+)$/m)?.[1];
  if (renameTo) {
    return {
      path: parseQuotedGitPath(renameTo),
      previousPath: renameFrom ? parseQuotedGitPath(renameFrom) : null,
    };
  }

  const next = section.match(/^\+\+\+\s+(.+)$/m)?.[1];
  if (next && next !== "/dev/null") {
    return { path: stripGitPrefix(parseQuotedGitPath(next)), previousPath: null };
  }

  const previous = section.match(/^---\s+(.+)$/m)?.[1];
  if (previous && previous !== "/dev/null") {
    return { path: stripGitPrefix(parseQuotedGitPath(previous)), previousPath: null };
  }

  const header = section.match(/^diff --git\s+(.+?)\s+(.+)$/m);
  if (!header) return null;
  const nextPath = stripGitPrefix(parseQuotedGitPath(header[2] ?? ""));
  if (nextPath && nextPath !== "/dev/null") {
    return { path: nextPath, previousPath: null };
  }
  const previousPath = stripGitPrefix(parseQuotedGitPath(header[1] ?? ""));
  return previousPath && previousPath !== "/dev/null"
    ? { path: previousPath, previousPath: null }
    : null;
}

function splitPatchByFile(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return [];
  return starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length));
}

function countLineChanges(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function classifySection(input: {
  readonly section: string;
  readonly additions: number;
  readonly deletions: number;
}): {
  readonly size: ReviewDiffFileSize;
  readonly isBinary: boolean;
  readonly hasHiddenBidiChars: boolean;
} {
  const isBinary =
    input.section.includes("GIT binary patch") ||
    input.section
      .split("\n")
      .some((line) => line.startsWith("Binary files ") && line.includes(" differ"));
  const hasHiddenBidiChars = BIDI_CHARS.test(input.section);
  const hasVeryLongLine = input.section
    .split("\n")
    .some((line) => line.length > MAX_CHARACTERS_PER_LINE);

  if (
    isBinary ||
    input.section.length > MAX_DIFF_SIZE ||
    input.deletions > DELETION_LINE_RENDER_LIMIT
  ) {
    return { size: "unrenderable", isBinary, hasHiddenBidiChars };
  }
  if (
    input.section.length >= MAX_REASONABLE_DIFF_SIZE ||
    hasVeryLongLine ||
    input.additions > DIFF_LINE_RENDER_LIMIT ||
    input.deletions > DIFF_LINE_RENDER_LIMIT
  ) {
    return { size: "large", isBinary, hasHiddenBidiChars };
  }
  return { size: "normal", isBinary, hasHiddenBidiChars };
}

export function summarizeReviewDiffFiles(files: ReadonlyArray<ReviewDiffFile>): ReviewDiffMetadata {
  return {
    filesChanged: files.length,
    totalAdditions: files.reduce((total, file) => total + file.additions, 0),
    totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
    largeFiles: files.filter((file) => file.size === "large").length,
    unrenderableFiles: files.filter((file) => file.size === "unrenderable").length,
  };
}

export function analyzeReviewDiff(diff: string): {
  readonly files: ReadonlyArray<ReviewDiffFile>;
  readonly metadata: ReviewDiffMetadata;
} {
  const sections = splitPatchByFile(diff);
  if (sections.length === 0) {
    return { files: [], metadata: EMPTY_METADATA };
  }

  const files = sections.flatMap((section): ReviewDiffFile[] => {
    const pathInfo = parseHeaderPath(section);
    if (!pathInfo) return [];
    const changes = countLineChanges(section);
    const classification = classifySection({ section, ...changes });
    return [
      {
        path: pathInfo.path,
        previousPath: pathInfo.previousPath,
        additions: changes.additions,
        deletions: changes.deletions,
        size: classification.size,
        isBinary: classification.isBinary,
        hasHiddenBidiChars: classification.hasHiddenBidiChars,
      },
    ];
  });

  return { files, metadata: summarizeReviewDiffFiles(files) };
}

export function emptyReviewDiffAnalysis(): {
  readonly files: ReadonlyArray<ReviewDiffFile>;
  readonly metadata: ReviewDiffMetadata;
} {
  return { files: [], metadata: EMPTY_METADATA };
}
