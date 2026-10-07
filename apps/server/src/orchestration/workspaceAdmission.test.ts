import {
  CommandId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  admitWorkspaceCommand,
  canonicalizeCommandWorktree,
  cleanupWorktreePath,
  commandWorktreePath,
  isWorktreeCleanupPending,
  type WorkspaceAdmissionDeps,
} from "./workspaceAdmission.ts";
import { WorkspaceOwnershipConflict } from "../persistence/Services/WorkspaceOwnership.ts";
import { canonicalizeWorktreePath } from "../git/worktreePaths.ts";

const threadId = ThreadId.make("admission-thread");
const commandId = CommandId.make("admission-command");

function archiveCommand(): OrchestrationCommand {
  return { type: "thread.archive", commandId, threadId };
}

const depsWithoutOwnership: WorkspaceAdmissionDeps = {
  findThread: () => undefined,
  findProject: () => undefined,
  listThreads: () => [],
  claimOwnership: () => Effect.die(new Error("claim must not run without a path")),
  hasCleanupReservationByPath: () => Effect.succeed(false),
  hasCleanupReservationByThreadId: () => Effect.succeed(false),
  cancelIdleByThreadId: () => Effect.void,
  restoreThreadWorktree: () => Effect.fail(new Error("restore callback is not configured")),
  createWorkspaceSnapshotCommit: () => Effect.die(new Error("snapshot must not run in this test")),
};

describe("commandWorktreePath", () => {
  it("reads the direct path from creation and handoff commands", () => {
    expect(
      commandWorktreePath({
        type: "thread.create",
        worktreePath: "/tmp/wt",
      } as OrchestrationCommand),
    ).toBe("/tmp/wt");
    expect(
      commandWorktreePath({
        type: "thread.workspace.handoff",
        worktreePath: "/tmp/wt",
      } as OrchestrationCommand),
    ).toBe("/tmp/wt");
  });

  it("returns null for commands without a direct path", () => {
    expect(commandWorktreePath(archiveCommand())).toBeNull();
    expect(
      commandWorktreePath({
        type: "thread.meta.update",
        worktreePath: null,
      } as OrchestrationCommand),
    ).toBeNull();
  });
});

describe("cleanupWorktreePath", () => {
  it("falls back to the thread worktree for queued and unarchive commands", () => {
    const threads = [{ id: threadId, worktreePath: "/tmp/thread-wt" } as OrchestrationThread];
    expect(
      cleanupWorktreePath(
        { type: "thread.queued-turn.dispatch", threadId } as OrchestrationCommand,
        threads,
      ),
    ).toBe("/tmp/thread-wt");
    expect(cleanupWorktreePath(archiveCommand(), [])).toBeNull();
  });
});

describe("canonicalizeCommandWorktree", () => {
  it("leaves commands without a worktree path untouched", async () => {
    const command = archiveCommand();
    await expect(Effect.runPromise(canonicalizeCommandWorktree(command))).resolves.toBe(command);
  });
});

describe("admitWorkspaceCommand", () => {
  it("allocates one real isolated worktree from the normalized source branch", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "admission-single-allocation-"));
    let allocatedPath: string | undefined;
    let explicitPath: string | undefined;
    const sourceFile = join(projectRoot, "README.md");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(sourceFile, "source\n"));
    execFileSync("git", ["init", "-b", "main", projectRoot], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      projectRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "add",
      "README.md",
    ]);
    execFileSync(
      "git",
      [
        "-C",
        projectRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      ],
      { stdio: "ignore" },
    );
    try {
      const projectId = "single-allocation-project";
      const command = {
        type: "thread.create",
        commandId,
        threadId,
        projectId,
        parentThreadId: null,
        title: "single allocation",
        modelSelection: { instanceId: "pi", model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        sourceWorktreePath: projectRoot,
        createdAt: "2026-09-05T00:00:00.000Z",
      } as OrchestrationCommand;
      const admitted = await Effect.runPromise(
        admitWorkspaceCommand(
          {
            ...depsWithoutOwnership,
            findProject: () =>
              ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
            claimOwnership: ({ worktreePath, branch }) =>
              Effect.succeed({ canonicalPath: worktreePath, worktreePath, branch, generation: 1 }),
            createWorkspaceSnapshotCommit: (cwd) =>
              Effect.sync(() =>
                execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              ),
          },
          command,
        ),
      );
      expect(admitted.type).toBe("thread.create");
      if (admitted.type !== "thread.create") throw new Error("Expected thread.create");
      allocatedPath = admitted.worktreePath ?? undefined;
      const expectedBranch = `t3/thread/${createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
      expect(admitted.branch).toBe(expectedBranch);
      expect(admitted.worktreePath).not.toBe(projectRoot);
      expect(
        execFileSync("git", ["-C", admitted.worktreePath!, "branch", "--show-current"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(expectedBranch);
      expect(
        execFileSync("git", ["-C", admitted.worktreePath!, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(
        execFileSync("git", ["-C", projectRoot, "rev-parse", "main"], { encoding: "utf8" }).trim(),
      );
      expect(admitted.workspaceBinding?.sourceBranch).toBe("main");
      expect(admitted.workspaceBinding?.sourceWorktreePath).toBe(projectRoot);
      const worktreeCountAfterCold =
        execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        }).match(/^worktree /gm)?.length ?? 0;
      expect(worktreeCountAfterCold).toBe(2);

      const admittedThread = {
        id: threadId,
        projectId,
        parentThreadId: null,
        branch: admitted.branch,
        worktreePath: admitted.worktreePath,
        workspaceBinding: admitted.workspaceBinding,
        deletedAt: null,
        archivedAt: null,
        latestTurn: null,
        session: null,
      } as unknown as OrchestrationThread;
      let claims = 0;
      const warmDeps: WorkspaceAdmissionDeps = {
        ...depsWithoutOwnership,
        findThread: () => admittedThread,
        findProject: () => ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
        claimOwnership: (input) => {
          claims += 1;
          return Effect.succeed({ ...admitted.workspaceBinding!, ...input, generation: claims });
        },
      };
      const warmCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("warm-admission"),
        threadId,
        bootstrap: {
          prepareWorktree: {
            projectCwd: projectRoot,
            baseBranch: "main",
            branch: expectedBranch,
          },
        },
      } as unknown as OrchestrationCommand;
      const warm = await Effect.runPromise(admitWorkspaceCommand(warmDeps, warmCommand));
      expect(warm.type).toBe("thread.turn.start");
      expect("workspaceBinding" in warm && warm.workspaceBinding?.worktreePath).toBe(allocatedPath);
      expect(claims).toBe(1);
      expect(
        execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        }).match(/^worktree /gm)?.length,
      ).toBe(worktreeCountAfterCold);

      const mismatched = await Effect.runPromise(
        admitWorkspaceCommand(warmDeps, {
          ...warmCommand,
          commandId: CommandId.make("mismatched-base"),
          bootstrap: {
            prepareWorktree: {
              projectCwd: projectRoot,
              baseBranch: "other",
              branch: expectedBranch,
            },
          },
        } as unknown as OrchestrationCommand).pipe(Effect.flip),
      );
      expect(mismatched).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect((mismatched as Error).message).toMatch(/base|source|binding/i);

      const legacyThread = {
        ...admittedThread,
        workspaceBinding: {
          canonicalPath: admitted.workspaceBinding!.canonicalPath,
          worktreePath: admitted.workspaceBinding!.worktreePath,
          branch: admitted.workspaceBinding!.branch,
          generation: admitted.workspaceBinding!.generation,
        },
      } as OrchestrationThread;
      const legacyFailure = await Effect.runPromise(
        admitWorkspaceCommand({ ...warmDeps, findThread: () => legacyThread }, warmCommand).pipe(
          Effect.flip,
        ),
      );
      expect(legacyFailure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect((legacyFailure as Error).message).toMatch(/legacy|source|binding/i);

      const explicitThreadId = ThreadId.make("admission-explicit-destination");
      const explicit = await Effect.runPromise(
        admitWorkspaceCommand(
          {
            ...depsWithoutOwnership,
            findProject: () =>
              ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
            claimOwnership: ({ worktreePath, branch }) =>
              Effect.succeed({ canonicalPath: worktreePath, worktreePath, branch, generation: 1 }),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("explicit-destination"),
            threadId: explicitThreadId,
            projectId,
            parentThreadId: null,
            title: "explicit destination",
            modelSelection: { instanceId: "pi", model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            workspaceBranch: "feature/bootstrap-explicit",
            worktreePath: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          } as unknown as OrchestrationCommand,
        ),
      );
      if (explicit.type !== "thread.create") throw new Error("Expected thread.create");
      explicitPath = explicit.worktreePath ?? undefined;
      expect(explicit.branch).toBe("feature/bootstrap-explicit");
      expect(
        execFileSync("git", ["-C", explicit.worktreePath!, "branch", "--show-current"], {
          encoding: "utf8",
        }).trim(),
      ).toBe("feature/bootstrap-explicit");
      expect(
        execFileSync("git", ["-C", explicit.worktreePath!, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(
        execFileSync("git", ["-C", projectRoot, "rev-parse", "main"], { encoding: "utf8" }).trim(),
      );

      execFileSync("git", ["-C", projectRoot, "branch", "feature/preexisting", "main"]);
      const preexistingFailure = await Effect.runPromise(
        admitWorkspaceCommand(
          {
            ...depsWithoutOwnership,
            findProject: () =>
              ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
            claimOwnership: ({ worktreePath, branch }) =>
              Effect.succeed({ canonicalPath: worktreePath, worktreePath, branch, generation: 1 }),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("preexisting-destination"),
            threadId: ThreadId.make("preexisting-destination-thread"),
            projectId,
            parentThreadId: null,
            title: "preexisting destination rejection",
            modelSelection: { instanceId: "pi", model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            workspaceBranch: "feature/preexisting",
            worktreePath: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          } as unknown as OrchestrationCommand,
        ).pipe(Effect.flip),
      );
      expect(preexistingFailure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect((preexistingFailure as Error).message).toMatch(/already exists/);
      expect(
        execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        }).match(/^worktree /gm)?.length,
      ).toBe(worktreeCountAfterCold + 1);

      const staleThreadId = ThreadId.make("stale-generated-destination");
      const staleGeneratedBranch = `t3/thread/${createHash("sha256").update(staleThreadId).digest("hex").slice(0, 24)}`;
      execFileSync("git", ["-C", projectRoot, "branch", staleGeneratedBranch, "main"]);
      const staleDestinationFailure = await Effect.runPromise(
        admitWorkspaceCommand(
          {
            ...depsWithoutOwnership,
            findProject: () =>
              ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
            claimOwnership: ({ worktreePath, branch }) =>
              Effect.succeed({ canonicalPath: worktreePath, worktreePath, branch, generation: 1 }),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("stale-generated-destination"),
            threadId: staleThreadId,
            projectId,
            parentThreadId: null,
            title: "stale generated branch rejection",
            modelSelection: { instanceId: "pi", model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          } as unknown as OrchestrationCommand,
        ).pipe(Effect.flip),
      );
      expect(staleDestinationFailure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect((staleDestinationFailure as Error).message).toMatch(/already exists/);
    } finally {
      for (const worktreePath of [allocatedPath, explicitPath].filter(
        (candidate): candidate is string => candidate !== undefined,
      )) {
        execFileSync("git", ["-C", projectRoot, "worktree", "remove", "--force", worktreePath], {
          stdio: "ignore",
        });
        await rm(worktreePath, { recursive: true, force: true });
      }
      const repositoryKey = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
      await rm(join(dirname(projectRoot), ".t3-thread-workspaces", repositoryKey), {
        recursive: true,
        force: true,
      });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps Review Code's branch as the source when it creates an isolated thread", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "admission-review-source-"));
    let allocatedPath: string | undefined;
    const sourceFile = join(projectRoot, "README.md");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(sourceFile, "review source\n"),
    );
    execFileSync("git", ["init", "-b", "main", projectRoot], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      projectRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "add",
      "README.md",
    ]);
    execFileSync(
      "git",
      [
        "-C",
        projectRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      ],
      { stdio: "ignore" },
    );
    const reviewThreadId = ThreadId.make("review-code-source-thread");
    try {
      const admitted = await Effect.runPromise(
        admitWorkspaceCommand(
          {
            ...depsWithoutOwnership,
            findProject: () =>
              ({ id: "review-project", workspaceRoot: projectRoot }) as OrchestrationProject,
            claimOwnership: ({ worktreePath, branch }) =>
              Effect.succeed({ canonicalPath: worktreePath, worktreePath, branch, generation: 1 }),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("review-source-create"),
            threadId: reviewThreadId,
            projectId: "review-project",
            parentThreadId: null,
            title: "Review Code",
            modelSelection: { instanceId: "pi", model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            reviewSnapshot: {
              scope: {
                kind: "against-base",
                branch: "main",
                baseBranch: "main",
                mergeBaseSha: execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
                  encoding: "utf8",
                }).trim(),
                untrackedFiles: [],
              },
              diff: "",
              diffHash: "review-diff-hash",
            },
            createdAt: "2026-09-05T00:00:00.000Z",
          } as unknown as OrchestrationCommand,
        ),
      );
      if (admitted.type !== "thread.create") throw new Error("Expected thread.create");
      allocatedPath = admitted.worktreePath ?? undefined;
      expect(admitted.branch).toMatch(/^t3\/thread\//);
      expect(admitted.branch).not.toBe("main");
      expect(
        execFileSync("git", ["-C", admitted.worktreePath!, "branch", "--show-current"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(admitted.branch);
      expect(
        execFileSync("git", ["-C", admitted.worktreePath!, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(
        execFileSync("git", ["-C", projectRoot, "rev-parse", "main"], { encoding: "utf8" }).trim(),
      );
    } finally {
      if (allocatedPath) {
        execFileSync("git", ["-C", projectRoot, "worktree", "remove", "--force", allocatedPath], {
          stdio: "ignore",
        });
        await rm(allocatedPath, { recursive: true, force: true });
      }
      const repositoryKey = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
      await rm(join(dirname(projectRoot), ".t3-thread-workspaces", repositoryKey), {
        recursive: true,
        force: true,
      });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns pathless commands without claiming ownership", async () => {
    const claimOwnership = vi.fn(depsWithoutOwnership.claimOwnership);
    const command = await Effect.runPromise(
      admitWorkspaceCommand({ ...depsWithoutOwnership, claimOwnership }, archiveCommand()),
    );
    expect(command).toEqual(archiveCommand());
    expect(claimOwnership).not.toHaveBeenCalled();
  });

  it("maps an ownership conflict to an invariant error naming the owner", async () => {
    const claimOwnership = () =>
      Effect.fail(
        new WorkspaceOwnershipConflict({
          canonicalPath: "/tmp/wt",
          ownerThreadId: "owner-thread",
          requestedByThreadId: "admission-thread",
        }),
      );
    const command = {
      type: "thread.create",
      commandId,
      threadId,
      worktreePath: "/tmp",
    } as OrchestrationCommand;
    const failure = await Effect.runPromise(
      admitWorkspaceCommand({ ...depsWithoutOwnership, claimOwnership }, command).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((failure as Error).message).toContain("owner-thread");
  });

  it("attaches the claimed binding to the admitted command", async () => {
    const binding: WorkspaceBinding = {
      canonicalPath: "/tmp",
      worktreePath: "/tmp",
      branch: null,
      generation: 1,
    };
    const command = {
      type: "thread.create",
      commandId,
      threadId,
      worktreePath: "/tmp",
    } as OrchestrationCommand;
    const admitted = (await Effect.runPromise(
      admitWorkspaceCommand(
        { ...depsWithoutOwnership, claimOwnership: () => Effect.succeed(binding) },
        command,
      ),
    )) as { readonly workspaceBinding?: WorkspaceBinding };
    expect(admitted.workspaceBinding).toEqual(binding);
  });

  it("rejects an existing thread whose persisted worktree is missing instead of admitting a dead cwd", async () => {
    const missingPath = `/tmp/t3-missing-admission-${crypto.randomUUID()}`;
    const thread = {
      id: threadId,
      projectId: "project-admission",
      branch: "feature/admission",
      worktreePath: missingPath,
      workspaceBinding: null,
    } as unknown as OrchestrationThread;
    const project = {
      id: thread.projectId,
      workspaceRoot: "/tmp",
    } as OrchestrationProject;
    const deps: WorkspaceAdmissionDeps = {
      ...depsWithoutOwnership,
      findThread: () => thread,
      findProject: () => project,
    };
    const failure = await Effect.runPromise(
      admitWorkspaceCommand(deps, {
        type: "thread.turn.start",
        commandId,
        threadId,
      } as OrchestrationCommand).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((failure as Error).message).toMatch(/restore|missing|worktree/i);
  });

  it("rejects handoff and meta.update targeting the project checkout", async () => {
    // The project checkout is reserved for the human: these commands must
    // fail before claiming ownership, never admit the main checkout as the
    // thread's workspace.
    const projectRoot = await mkdtemp(join(tmpdir(), "admission-project-"));
    execFileSync("git", ["init", projectRoot], { stdio: "ignore" });
    try {
      const projectId = "admission-project";
      const deps: WorkspaceAdmissionDeps = {
        findThread: () => ({ id: threadId, projectId }) as OrchestrationThread,
        findProject: () => ({ id: projectId, workspaceRoot: projectRoot }) as OrchestrationProject,
        listThreads: () => [],
        claimOwnership: () => Effect.die(new Error("must reject before claiming ownership")),
        hasCleanupReservationByPath: () => Effect.succeed(false),
        hasCleanupReservationByThreadId: () => Effect.succeed(false),
        cancelIdleByThreadId: () => Effect.void,
        restoreThreadWorktree: () => Effect.fail(new Error("restore must not run in this test")),
        createWorkspaceSnapshotCommit: () =>
          Effect.die(new Error("snapshot must not run in this test")),
      };
      const commands = [
        {
          type: "thread.workspace.handoff",
          commandId,
          threadId,
          branch: "handoff-branch",
          worktreePath: projectRoot,
        },
        { type: "thread.meta.update", commandId, threadId, worktreePath: projectRoot },
      ] as Array<OrchestrationCommand>;
      for (const command of commands) {
        const failure = await Effect.runPromise(
          admitWorkspaceCommand(deps, command).pipe(Effect.flip),
        );
        expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
        expect((failure as Error).message).toContain("reserved for the human");
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("admitWorkspaceCommand fork lineage sharing", () => {
  const sourceThreadId = ThreadId.make("fork-family-source");
  const forkThreadId = ThreadId.make("fork-family-fork");
  const siblingThreadId = ThreadId.make("fork-family-sibling");
  const outsiderThreadId = ThreadId.make("fork-family-outsider");
  let fixtureRoot = "";
  let worktreePath = "";
  let childWorktree = "";
  let separateWorktree = "";
  let lineage: ReadonlyArray<OrchestrationThread> = [];

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "t3-workspace-lineage-"));
    worktreePath = join(fixtureRoot, "shared");
    childWorktree = join(fixtureRoot, "child");
    separateWorktree = join(fixtureRoot, "separate");
    await Promise.all(
      [worktreePath, childWorktree, separateWorktree].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    lineage = [
      thread(sourceThreadId, null),
      thread(forkThreadId, sourceThreadId),
      thread(siblingThreadId, sourceThreadId),
      thread(outsiderThreadId, null),
    ];
  });

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  const thread = (
    id: ThreadId,
    parentThreadId: ThreadId | null,
    overrides: Partial<OrchestrationThread> = {},
  ) =>
    ({
      id,
      projectId: "fork-family-project",
      title: id,
      modelSelection: { instanceId: "pi", model: "default" },
      interactionMode: "default",
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      branch: "t3/thread/fork-family",
      worktreePath,
      parentThreadId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      ...overrides,
    }) as unknown as OrchestrationThread;

  // The outsider shares the same worktree path but has no fork lineage: it is
  // the conflict case the family allowance must not loosen.
  const depsWith = (overrides: Partial<WorkspaceAdmissionDeps> = {}): WorkspaceAdmissionDeps => ({
    ...depsWithoutOwnership,
    findThread: (id) => lineage.find((entry) => entry.id === id),
    listThreads: () => lineage,
    claimOwnership: () =>
      Effect.succeed({
        canonicalPath: worktreePath,
        worktreePath,
        branch: "t3/thread/fork-family",
        generation: 2,
      }),
    ...overrides,
  });

  const turnStart = (id: ThreadId) =>
    ({
      type: "thread.turn.start",
      commandId,
      threadId: id,
    }) as unknown as OrchestrationCommand;

  it("offers a fork its source as a co-owner so the fork can claim the shared worktree", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(forkThreadId)),
    );
    expect(claimOwnership).toHaveBeenCalledTimes(1);
    const input = claimOwnership.mock.calls[0]![0];
    expect(input.coOwnerThreadIds).toContain(sourceThreadId);
    expect(input.coOwnerThreadIds).toContain(siblingThreadId);
    expect(input.coOwnerThreadIds).not.toContain(outsiderThreadId);
  });

  it("treats sibling forks of the same source as relatives", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(siblingThreadId)),
    );
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds).toContain(forkThreadId);
  });

  it("refuses while a relative is running so one checkout keeps a single writer", async () => {
    const running = lineage.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    const failure = await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => running.find((entry) => entry.id === id),
          listThreads: () => running,
        }),
        turnStart(forkThreadId),
      ).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((failure as Error).message).toContain(sourceThreadId);
    expect(claimOwnership).not.toHaveBeenCalled();
  });

  it("leaves unrelated threads in conflict", async () => {
    const claimOwnership = vi.fn(depsWith().claimOwnership);
    await Effect.runPromise(
      admitWorkspaceCommand(depsWith({ claimOwnership }), turnStart(outsiderThreadId)),
    );
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).not.toContain(sourceThreadId);
  });

  it("admits a delegated child that owns its own worktree while its parent runs", async () => {
    // `parentThreadId` is also the delegated-child relation (cli.ts sets it on
    // `thread.create` for `t3 chat new --parent`), and a child is allocated its
    // own isolated worktree while the parent's session is still running.
    const childThreadId = ThreadId.make("delegated-child");
    const withChild = [
      ...lineage,
      thread(childThreadId, sourceThreadId, { worktreePath: childWorktree }),
    ];
    const runningSource = thread(sourceThreadId, null, {
      latestTurn: {
        turnId: TurnId.make("turn-running"),
        state: "running",
        requestedAt: "2025-01-01T00:00:00.000Z",
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const withRunningParent = withChild.map((entry) =>
      entry.id === sourceThreadId ? runningSource : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => withRunningParent.find((entry) => entry.id === id),
          listThreads: () => withRunningParent,
        }),
        turnStart(childThreadId),
      ),
    );

    expect(claimOwnership).toHaveBeenCalledTimes(1);
    expect(claimOwnership.mock.calls[0]![0].worktreePath).toBe(
      await canonicalizeWorktreePath(childWorktree),
    );
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).not.toContain(sourceThreadId);
  });

  it("ignores a relative bound to a different worktree", async () => {
    // A fork handed off to its own checkout no longer shares anything, so a
    // running source elsewhere must not block it.
    const handedOff = lineage.map((entry) =>
      entry.id === forkThreadId
        ? thread(forkThreadId, sourceThreadId, { worktreePath: separateWorktree })
        : entry,
    );
    const running = handedOff.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => running.find((entry) => entry.id === id),
          listThreads: () => running,
        }),
        turnStart(forkThreadId),
      ),
    );

    expect(claimOwnership).toHaveBeenCalledTimes(1);
    expect(claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? []).toEqual([]);
  });

  it("ignores archived and deleted relatives left mid-turn", async () => {
    const stale = lineage.map((entry) =>
      entry.id === sourceThreadId
        ? thread(sourceThreadId, null, {
            archivedAt: "2025-01-02T00:00:00.000Z",
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2025-01-01T00:00:00.000Z",
              startedAt: "2025-01-01T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : entry,
    );
    const claimOwnership = vi.fn(depsWith().claimOwnership);

    await Effect.runPromise(
      admitWorkspaceCommand(
        depsWith({
          claimOwnership,
          findThread: (id) => stale.find((entry) => entry.id === id),
          listThreads: () => stale,
        }),
        turnStart(forkThreadId),
      ),
    );

    // Claimed rather than refused: an archived relative stuck on a running turn
    // must not block its family with advice to stop an unstoppable thread. The
    // idle sibling on the same checkout is still a legitimate co-owner.
    expect(claimOwnership).toHaveBeenCalledTimes(1);
    const coOwners = claimOwnership.mock.calls[0]![0].coOwnerThreadIds ?? [];
    expect(coOwners).not.toContain(sourceThreadId);
    expect(coOwners).toContain(siblingThreadId);
  });
});

describe("isWorktreeCleanupPending", () => {
  it("delegates to the reservation lookup by canonical path", async () => {
    const hasCleanupReservationByPath = vi.fn(() => Effect.succeed(true));
    await expect(
      Effect.runPromise(isWorktreeCleanupPending({ hasCleanupReservationByPath }, "/tmp")),
    ).resolves.toBe(true);
    expect(hasCleanupReservationByPath).toHaveBeenCalledTimes(1);
  });
});
