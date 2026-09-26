import { isProjectCheckoutPath } from "./components/BranchToolbar.logic";
import type { Thread } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<Thread, "id" | "worktreePath">>,
  threadId: Thread["id"],
  projectCwd?: string | null,
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  // Never offer worktree cleanup for the project checkout itself.
  if (isProjectCheckoutPath(targetWorktreePath, projectCwd ?? null)) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
