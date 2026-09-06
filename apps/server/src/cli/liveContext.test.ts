import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { runProcess } from "../processRunner.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { findProjectForCli, type CliSnapshot } from "./liveContext.ts";

const testLayer = WorkspacePathsLive.pipe(Layer.provideMerge(NodeServices.layer));

const project = (id: string, title: string, workspaceRoot: string) => ({
  id,
  title,
  workspaceRoot,
  deletedAt: null,
});

const thread = (id: string, projectId: string, worktreePath: string) => ({
  id,
  projectId,
  worktreePath,
  archivedAt: null,
  deletedAt: null,
});

const snapshot = (
  projects: ReadonlyArray<ReturnType<typeof project>>,
  threads: ReadonlyArray<ReturnType<typeof thread>> = [],
) => ({ projects, threads }) as unknown as CliSnapshot;

const resolveProject = (value: CliSnapshot, identifier: string) =>
  Effect.runPromise(findProjectForCli(value, identifier).pipe(Effect.provide(testLayer)));

const git = (cwd: string, args: ReadonlyArray<string>) => runProcess("git", ["-C", cwd, ...args]);

const initializeRepository = async (repositoryRoot: string): Promise<void> => {
  await mkdir(repositoryRoot, { recursive: true });
  await git(repositoryRoot, ["init"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "# Test\n", "utf8");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, [
    "-c",
    "user.name=T3 Test",
    "-c",
    "user.email=t3@example.com",
    "commit",
    "-m",
    "Initial commit",
  ]);
};

describe("findProjectForCli", () => {
  it("resolves projects by id and title", async () => {
    const value = snapshot([
      project("project-1", "Project One", "/unused/project-one"),
      project("project-2", "Project Two", "/unused/project-two"),
    ]);

    await expect(resolveProject(value, " project-1 ")).resolves.toMatchObject({
      id: "project-1",
    });
    await expect(resolveProject(value, "Project Two")).resolves.toMatchObject({
      id: "project-2",
    });
  });

  it("resolves normalized primary roots and nested paths from their Git root", async () => {
    const root = path.join(tmpdir(), `t3-project-resolution-${crypto.randomUUID()}`);
    const workspace = path.join(root, "workspace");
    const workspaceLink = path.join(root, "workspace-link");
    const nestedPath = path.join(workspace, "packages", "app");
    await initializeRepository(workspace);
    await mkdir(nestedPath, { recursive: true });
    await symlink(workspace, workspaceLink);

    const value = snapshot([project("project-1", "Project", workspaceLink)]);

    try {
      await expect(resolveProject(value, nestedPath)).resolves.toMatchObject({
        id: "project-1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves nested paths in an active owned linked worktree", async () => {
    const root = path.join(tmpdir(), `t3-project-worktree-${crypto.randomUUID()}`);
    const workspace = path.join(root, "workspace");
    const worktree = path.join(root, "worktree");
    const nestedPath = path.join(worktree, "packages", "app");
    await initializeRepository(workspace);
    await git(workspace, ["worktree", "add", "-b", "feature/test", worktree]);
    await mkdir(nestedPath, { recursive: true });

    const value = snapshot(
      [project("project-1", "Project", workspace)],
      [thread("thread-1", "project-1", worktree)],
    );

    try {
      await expect(resolveProject(value, nestedPath)).resolves.toMatchObject({
        id: "project-1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing explicit paths and missing projects distinctly", async () => {
    const root = path.join(tmpdir(), `t3-project-missing-${crypto.randomUUID()}`);
    const missingPath = path.join(root, "missing");
    const value = snapshot([]);

    await expect(resolveProject(value, missingPath)).rejects.toThrow(
      `Workspace root does not exist: ${missingPath}`,
    );
    await expect(resolveProject(value, "missing-project")).rejects.toThrow(
      "No active project found for 'missing-project'.",
    );
  });

  it("rejects ambiguous primary roots with candidate project ids", async () => {
    const root = path.join(tmpdir(), `t3-project-ambiguous-root-${crypto.randomUUID()}`);
    const workspace = path.join(root, "workspace");
    const workspaceLink = path.join(root, "workspace-link");
    await mkdir(workspace, { recursive: true });
    await symlink(workspace, workspaceLink);

    const value = snapshot([
      project("project-2", "Project Two", workspaceLink),
      project("project-1", "Project One", workspace),
    ]);

    try {
      await expect(resolveProject(value, workspace)).rejects.toThrow(
        "Candidate project ids: project-1, project-2.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an owned worktree shared by active projects with candidate project ids", async () => {
    const root = path.join(tmpdir(), `t3-project-ambiguous-worktree-${crypto.randomUUID()}`);
    const projectOne = path.join(root, "project-one");
    const projectTwo = path.join(root, "project-two");
    const worktree = path.join(root, "worktree");
    await Promise.all([
      mkdir(projectOne, { recursive: true }),
      mkdir(projectTwo, { recursive: true }),
      mkdir(worktree, { recursive: true }),
    ]);

    const value = snapshot(
      [
        project("project-2", "Project Two", projectTwo),
        project("project-1", "Project One", projectOne),
      ],
      [thread("thread-1", "project-1", worktree), thread("thread-2", "project-2", worktree)],
    );

    try {
      await expect(resolveProject(value, worktree)).rejects.toThrow(
        "Candidate project ids: project-1, project-2.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
