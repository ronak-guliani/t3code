import type { DiffFileDelta, DiffSnapshot } from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/types";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export interface PatchCacheKeyOptions {
  readonly scope?: string;
  readonly revision?: string | null;
}

function resolvePatchCacheKeyOptions(options?: string | PatchCacheKeyOptions): {
  readonly scope: string;
  readonly revision: string | null;
} {
  if (typeof options === "string") {
    return { scope: options, revision: null };
  }
  return {
    scope: options?.scope ?? "diff-panel",
    revision: options?.revision ?? null,
  };
}

export function buildPatchCacheKey(patch: string, options?: string | PatchCacheKeyOptions): string {
  const { revision, scope } = resolvePatchCacheKeyOptions(options);
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  if (revision) {
    return `${scope}:revision:${revision}:${normalizedPatch.length}:${primary}:${secondary}`;
  }

  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export function applyDiffFileDelta(snapshot: DiffSnapshot, delta: DiffFileDelta): DiffSnapshot {
  if (
    snapshot.threadId !== delta.threadId ||
    snapshot.fromTurnCount !== delta.fromTurnCount ||
    snapshot.toTurnCount !== delta.toTurnCount ||
    snapshot.scope !== delta.scope
  ) {
    return snapshot;
  }

  const nextFiles = new Map(snapshot.files.map((file) => [file.path, file] as const));
  if (delta.file) {
    nextFiles.set(delta.path, delta.file);
  } else {
    nextFiles.delete(delta.path);
  }

  return {
    ...snapshot,
    metadata: delta.metadata,
    files: [...nextFiles.values()].toSorted((left, right) => left.path.localeCompare(right.path)),
  };
}

export interface UnsafeFileDiff {
  readonly file: FileDiffMetadata;
  readonly reason: string;
}

export interface RenderableFileDiffPartition {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly unsafeFiles: ReadonlyArray<UnsafeFileDiff>;
}

function hasLine(lines: ReadonlyArray<string>, index: number): boolean {
  return typeof lines[index] === "string";
}

export function getFileDiffRenderSafety(file: FileDiffMetadata):
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly reason: string;
    } {
  for (const hunk of file.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let offset = 0; offset < segment.lines; offset += 1) {
          if (
            !hasLine(file.deletionLines, deletionLineIndex + offset) ||
            !hasLine(file.additionLines, additionLineIndex + offset)
          ) {
            return {
              safe: false,
              reason: "Parsed diff context references missing line content.",
            };
          }
        }
        deletionLineIndex += segment.lines;
        additionLineIndex += segment.lines;
        continue;
      }

      for (let offset = 0; offset < segment.deletions; offset += 1) {
        if (!hasLine(file.deletionLines, deletionLineIndex + offset)) {
          return {
            safe: false,
            reason: "Parsed diff deletion references missing line content.",
          };
        }
      }
      for (let offset = 0; offset < segment.additions; offset += 1) {
        if (!hasLine(file.additionLines, additionLineIndex + offset)) {
          return {
            safe: false,
            reason: "Parsed diff addition references missing line content.",
          };
        }
      }
      deletionLineIndex += segment.deletions;
      additionLineIndex += segment.additions;
    }
  }

  return { safe: true };
}

export function partitionRenderableFileDiffs(
  files: ReadonlyArray<FileDiffMetadata>,
): RenderableFileDiffPartition {
  const renderableFiles: FileDiffMetadata[] = [];
  const unsafeFiles: UnsafeFileDiff[] = [];

  for (const file of files) {
    const safety = getFileDiffRenderSafety(file);
    if (safety.safe) {
      renderableFiles.push(file);
    } else {
      unsafeFiles.push({ file, reason: safety.reason });
    }
  }

  return { files: renderableFiles, unsafeFiles };
}
