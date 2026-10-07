/**
 * Large diffs start folded so a panel holding one enormous file is still
 * scannable. The server already tags each file `normal | large | unrenderable`,
 * so the default is derived rather than configured.
 *
 * User intent is stored separately and always wins. A default set seeded once
 * into component state would be re-applied every time the snapshot resolves or
 * the selected turn changes, quietly re-folding a file someone had opened.
 */
export function mergeCollapsedFileKeys(
  defaultCollapsed: ReadonlySet<string>,
  overrides: ReadonlyMap<string, boolean>,
): ReadonlySet<string> {
  const merged = new Set(defaultCollapsed);
  for (const [fileKey, collapsed] of overrides) {
    if (collapsed) {
      merged.add(fileKey);
    } else {
      merged.delete(fileKey);
    }
  }
  return merged;
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

/** Records an explicit state for every rendered file, overriding the large-diff default. */
export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  collapsed: boolean,
): ReadonlyMap<string, boolean> {
  return new Map(fileKeys.map((fileKey) => [fileKey, collapsed]));
}
