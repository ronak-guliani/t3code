import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { findProjectForCli, type CliSnapshot } from "./liveContext.ts";

const testLayer = WorkspacePathsLive.pipe(Layer.provideMerge(NodeServices.layer));

describe("findProjectForCli", () => {
  it("resolves canonical and symlink-equivalent workspace paths", async () => {
    const root = path.join(tmpdir(), `t3-project-resolution-${crypto.randomUUID()}`);
    const workspace = path.join(root, "workspace");
    const workspaceLink = path.join(root, "workspace-link");
    await mkdir(workspace, { recursive: true });
    await symlink(workspace, workspaceLink);

    const snapshot = {
      projects: [
        {
          id: "project-1",
          title: "Project",
          workspaceRoot: workspaceLink,
          deletedAt: null,
        },
      ],
      threads: [],
    } as unknown as CliSnapshot;

    try {
      const project = await Effect.runPromise(
        findProjectForCli(snapshot, await realpath(workspace)).pipe(Effect.provide(testLayer)),
      );
      expect(project.id).toBe("project-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a registered project from one of its active worktrees", async () => {
    const root = path.join(tmpdir(), `t3-project-worktree-${crypto.randomUUID()}`);
    const workspace = path.join(root, "workspace");
    const worktree = path.join(root, "worktree");
    await mkdir(workspace, { recursive: true });
    await mkdir(worktree, { recursive: true });

    const snapshot = {
      projects: [
        {
          id: "project-1",
          title: "Project",
          workspaceRoot: workspace,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          worktreePath: worktree,
          archivedAt: null,
          deletedAt: null,
        },
      ],
    } as unknown as CliSnapshot;

    try {
      const project = await Effect.runPromise(
        findProjectForCli(snapshot, worktree).pipe(Effect.provide(testLayer)),
      );
      expect(project.id).toBe("project-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a worktree shared by threads from different active projects", async () => {
    const root = path.join(tmpdir(), `t3-project-ambiguous-worktree-${crypto.randomUUID()}`);
    const projectOne = path.join(root, "project-one");
    const projectTwo = path.join(root, "project-two");
    const worktree = path.join(root, "worktree");
    await Promise.all([
      mkdir(projectOne, { recursive: true }),
      mkdir(projectTwo, { recursive: true }),
      mkdir(worktree, { recursive: true }),
    ]);

    const snapshot = {
      projects: [
        {
          id: "project-1",
          title: "Project One",
          workspaceRoot: projectOne,
          deletedAt: null,
        },
        {
          id: "project-2",
          title: "Project Two",
          workspaceRoot: projectTwo,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          worktreePath: worktree,
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "thread-2",
          projectId: "project-2",
          worktreePath: worktree,
          archivedAt: null,
          deletedAt: null,
        },
      ],
    } as unknown as CliSnapshot;

    try {
      await expect(
        Effect.runPromise(findProjectForCli(snapshot, worktree).pipe(Effect.provide(testLayer))),
      ).rejects.toThrow(/Multiple active projects contain worktree .* Use the project id instead/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
