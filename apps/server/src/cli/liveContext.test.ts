import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { findProjectForCli, type CliSnapshot } from "./liveContext.ts";

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
        findProjectForCli(snapshot, await realpath(workspace)).pipe(
          Effect.provide(WorkspacePathsLive.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      );
      expect(project.id).toBe("project-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
