import { parsePatchFiles } from "@pierre/diffs";
import type { ChangeTypes } from "@pierre/diffs/types";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath: string | null;
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "copied";
  readonly additions: number;
  readonly deletions: number;
}

export interface ParsedTurnDiffFile extends TurnDiffFileSummary {
  readonly section: string;
}

export interface TurnDiffFileStatus {
  readonly path: string;
  readonly previousPath: string | null;
  readonly kind: TurnDiffFileSummary["kind"];
}

function changeTypeToKind(changeType: ChangeTypes): TurnDiffFileSummary["kind"] {
  switch (changeType) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

function parseNumstatCount(value: string | undefined): number {
  if (value === undefined || value === "-") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseTurnDiffFilesFromUnifiedDiff(diff: string): ReadonlyArray<ParsedTurnDiffFile> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const sectionStarts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  const parsedFiles = parsePatchFiles(normalized).flatMap((patch) => patch.files);
  const files = parsedFiles.map((file, index) => {
    const sectionStart = sectionStarts[index];
    const section =
      sectionStart === undefined
        ? ""
        : diff.slice(sectionStart, sectionStarts[index + 1] ?? diff.length);
    const isCopied = section.includes("\ncopy from ") && section.includes("\ncopy to ");
    return {
      path: file.name,
      previousPath: file.prevName ?? null,
      kind: isCopied ? ("copied" as const) : changeTypeToKind(file.type),
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
      section,
    };
  });

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  if (numstat.length === 0) {
    return [];
  }

  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];
  let index = 0;
  while (index < records.length) {
    const header = records[index] ?? "";
    index += 1;
    if (header.length === 0) {
      continue;
    }

    const [additionsRaw, deletionsRaw, ...pathParts] = header.split("\t");
    if (additionsRaw === undefined || deletionsRaw === undefined) {
      continue;
    }

    let filePath = pathParts.join("\t");
    let previousPath: string | null = null;
    if (filePath.length === 0) {
      const oldPath = records[index] ?? "";
      const newPath = records[index + 1] ?? "";
      index += 2;
      filePath = newPath.length > 0 ? newPath : oldPath;
      previousPath = oldPath.length > 0 ? oldPath : null;
    }
    if (filePath.length === 0) {
      continue;
    }

    files.push({
      path: filePath,
      previousPath,
      kind: previousPath === null ? "modified" : "renamed",
      additions: parseNumstatCount(additionsRaw),
      deletions: parseNumstatCount(deletionsRaw),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseTurnDiffFileStatusesFromNameStatus(
  nameStatus: string,
): ReadonlyArray<TurnDiffFileStatus> {
  const records = nameStatus.split("\0");
  const files: TurnDiffFileStatus[] = [];
  let index = 0;
  while (index < records.length) {
    const status = records[index] ?? "";
    index += 1;
    if (status.length === 0) {
      continue;
    }

    const statusKind = status[0];
    const firstPath = records[index] ?? "";
    index += 1;
    if (firstPath.length === 0) {
      continue;
    }

    if (statusKind === "R" || statusKind === "C") {
      const nextPath = records[index] ?? "";
      index += 1;
      if (nextPath.length === 0) {
        continue;
      }
      files.push({
        path: nextPath,
        previousPath: firstPath,
        kind: statusKind === "R" ? "renamed" : "copied",
      });
      continue;
    }

    const kind =
      statusKind === "A"
        ? "added"
        : statusKind === "D"
          ? "deleted"
          : statusKind === "M" || statusKind === "T"
            ? "modified"
            : null;
    if (kind !== null) {
      files.push({ path: firstPath, previousPath: null, kind });
    }
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}
