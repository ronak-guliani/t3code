/**
 * Pure helpers for deciding whether an archived chat should schedule worktree cleanup.
 */
import path from "node:path";

export function isRemovableArchiveWorktreePath(input: {
  readonly canonicalWorktreePath: string;
  readonly canonicalWorkspaceRoot: string;
}): boolean {
  const relativePath = path.relative(input.canonicalWorkspaceRoot, input.canonicalWorktreePath);
  return (
    relativePath !== "" &&
    (relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath))
  );
}

export function shouldScheduleArchiveWorktreeCleanup(input: {
  readonly pullRequestState: "open" | "closed" | "merged" | null | undefined;
  readonly hasActiveOwner: boolean;
  readonly isRemovableWorktreePath: boolean;
}): boolean {
  return (
    input.pullRequestState === "merged" && !input.hasActiveOwner && input.isRemovableWorktreePath
  );
}
