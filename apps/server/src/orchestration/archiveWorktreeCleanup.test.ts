import { describe, expect, it } from "vitest";

import {
  isRemovableArchiveWorktreePath,
  shouldScheduleArchiveWorktreeCleanup,
} from "./archiveWorktreeCleanup.ts";

describe("archiveWorktreeCleanup", () => {
  it("rejects the project workspace root", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(false);
  });

  it("allows linked worktree paths", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo-worktrees/feature",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(true);
  });

  it("rejects worktree paths nested below the project workspace root", () => {
    expect(
      isRemovableArchiveWorktreePath({
        canonicalWorktreePath: "/repo/nested/feature",
        canonicalWorkspaceRoot: "/repo",
      }),
    ).toBe(false);
  });

  it("schedules only merged sole-owner removable paths", () => {
    expect(
      shouldScheduleArchiveWorktreeCleanup({
        pullRequestState: "merged",
        hasActiveOwner: false,
        isRemovableWorktreePath: true,
      }),
    ).toBe(true);

    expect(
      shouldScheduleArchiveWorktreeCleanup({
        pullRequestState: "open",
        hasActiveOwner: false,
        isRemovableWorktreePath: true,
      }),
    ).toBe(false);

    expect(
      shouldScheduleArchiveWorktreeCleanup({
        pullRequestState: "merged",
        hasActiveOwner: true,
        isRemovableWorktreePath: true,
      }),
    ).toBe(false);

    expect(
      shouldScheduleArchiveWorktreeCleanup({
        pullRequestState: "merged",
        hasActiveOwner: false,
        isRemovableWorktreePath: false,
      }),
    ).toBe(false);
  });
});
