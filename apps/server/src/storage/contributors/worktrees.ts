/**
 * Agent worktrees and the worktree trash. Archived chats' worktrees (#604)
 * and idle active chats' worktrees (#684, age ignored by a reset) are
 * reclaimed through the durable cleanup job (reservation, detach-by-rename,
 * background delete) and restore on unarchive / the next turn. The trash holds
 * already-detached checkouts.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { StorageCategoryUsage, StorageCleanupItemResult, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { isRemovableArchiveWorktreePath } from "../../orchestration/archiveWorktreeCleanup.ts";
import { worktreeTrashDirectory } from "../../orchestration/Layers/ThreadDeletionReactor.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../../orchestration/Services/ThreadDeletionReactor.ts";
import { findCanonicalActiveWorktreeOwner } from "../../orchestration/worktreeOwnership.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { readCleanupRuntimeSnapshot, threadCleanupBlockers } from "../cleanupSafety.ts";
import { measureDirectory } from "../measureDirectory.ts";
import type { StorageCleanupContributor, StoragePlanEntry } from "../StorageCleanup.ts";

const TRASH_DIRECTORY_NAME = ".t3-worktree-trash";
const MEASURE_CONCURRENCY = 4;

const REASON_TEXT: Record<string, string> = {
  "dirty-worktree": "has uncommitted or untracked changes",
  "active-worktree-owner": "another active chat uses this worktree",
  "owner-reopened": "chat was unarchived",
  "project-workspace-root": "is the project checkout",
  "worktree-branch-mismatch": "checked-out branch no longer matches the chat",
  "worktree-registration-mismatch": "worktree is not registered with the project",
  "repository-unavailable": "project repository is unavailable",
};

type WorktreePayload =
  | { readonly kind: "worktree"; readonly threadId: ThreadId; readonly path: string }
  | { readonly kind: "trash"; readonly path: string };

async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

export const makeWorktreeStorageContributor = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const reactor = yield* ThreadDeletionReactor;
  const cleanupJobs = yield* WorktreeCleanupJobRepository;
  const git = yield* GitCore;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  // Apparent size per canonical path from the last measurement; plans use it
  // for estimates instead of re-walking hundreds of gigabytes.
  let sizeCache = new Map<string, number>();

  const worktreeRoots = Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    const roots = new Set<string>([config.worktreesDir]);
    for (const project of readModel.projects) {
      roots.add(path.join(path.dirname(project.workspaceRoot), ".t3-thread-workspaces"));
    }
    return [...roots];
  });

  const trashDirectories = Effect.gen(function* () {
    const roots = yield* worktreeRoots;
    const jobs = yield* cleanupJobs.list().pipe(Effect.orElseSucceed(() => []));
    const repositoryDirectories = yield* Effect.promise(() =>
      Promise.all(roots.map(listDirectories)),
    );
    return [
      ...new Set([
        ...repositoryDirectories.flat().map((dir) => path.join(dir, TRASH_DIRECTORY_NAME)),
        ...jobs.map((job) => worktreeTrashDirectory(job.canonicalWorktreePath)),
      ]),
    ];
  });

  const measure: StorageCleanupContributor["measure"] = ({ signal, report }) =>
    Effect.gen(function* () {
      const roots = yield* worktreeRoots;
      const trash = yield* trashDirectories;
      const worktrees = yield* Effect.promise(async () => {
        const repositories = (await Promise.all(roots.map(listDirectories))).flat();
        const children = await Promise.all(repositories.map(listDirectories));
        return children.flat().filter((dir) => path.basename(dir) !== TRASH_DIRECTORY_NAME);
      });
      const trashEntries = yield* Effect.promise(async () =>
        (await Promise.all(trash.map(listDirectories))).flat(),
      );

      const nextCache = new Map<string, number>();
      const totals = {
        worktrees: { bytes: 0, items: 0 },
        worktreeTrash: { bytes: 0, items: 0 },
      };
      const publish = (category: "worktrees" | "worktreeTrash", status: "measuring" | "complete") =>
        report({
          category,
          status,
          bytes: totals[category].bytes,
          items: totals[category].items,
          ...(category === "worktrees"
            ? { detail: `${worktrees.length} worktree directories` }
            : {}),
        } satisfies StorageCategoryUsage);

      const measureAll = (
        targets: ReadonlyArray<string>,
        category: "worktrees" | "worktreeTrash",
      ) =>
        Effect.forEach(
          targets,
          (target) =>
            Effect.promise(() => measureDirectory(target, { signal })).pipe(
              Effect.flatMap((size) =>
                Effect.gen(function* () {
                  const canonical = yield* Effect.promise(() => canonicalizeWorktreePath(target));
                  nextCache.set(canonical, size.bytes);
                  totals[category].bytes += size.bytes;
                  totals[category].items += 1;
                  yield* publish(category, "measuring");
                }),
              ),
            ),
          { concurrency: MEASURE_CONCURRENCY, discard: true },
        );

      yield* measureAll(trashEntries, "worktreeTrash");
      yield* publish("worktreeTrash", "complete");
      yield* measureAll(worktrees, "worktrees");
      sizeCache = nextCache;
      yield* publish("worktrees", "complete");
    });

  const sizeOf = (target: string) =>
    Effect.promise(async () => {
      const canonicalPath = await canonicalizeWorktreePath(target);
      const cached = sizeCache.get(canonicalPath);
      if (cached !== undefined) return cached;
      const { bytes } = await measureDirectory(canonicalPath);
      sizeCache.set(canonicalPath, bytes);
      return bytes;
    });

  /** Every safety rule for one chat's worktree (age ignored); null when eligible. */
  const worktreeBlocker = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      if (thread === undefined || thread.deletedAt !== null) return "chat no longer exists";
      if (thread.worktreePath === null || thread.branch === null) return "chat has no worktree";
      const project = readModel.projects.find((entry) => entry.id === thread.projectId);
      if (project === undefined || project.deletedAt !== null) return "project is unavailable";
      const canonicalPath = yield* Effect.promise(() =>
        canonicalizeWorktreePath(thread.worktreePath!),
      );
      const canonicalRoot = yield* Effect.promise(() =>
        canonicalizeWorktreePath(project.workspaceRoot),
      );
      if (
        !isRemovableArchiveWorktreePath({
          canonicalWorktreePath: canonicalPath,
          canonicalWorkspaceRoot: canonicalRoot,
        })
      ) {
        return REASON_TEXT["project-workspace-root"]!;
      }
      if (!(yield* Effect.promise(() => pathExists(canonicalPath)))) {
        return "worktree is already gone";
      }
      const shell = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(shell)) return "chat no longer exists";
      const runtime = yield* readCleanupRuntimeSnapshot({ providerService, terminalManager });
      const blockers = threadCleanupBlockers(shell.value, runtime, { terminalSubprocesses: true });
      if (blockers.length > 0) return blockers.join("; ");
      const terminalInPath = yield* Effect.forEach(
        runtime.terminals.filter((terminal) => terminal.hasRunningSubprocess),
        (terminal) =>
          Effect.promise(() => canonicalizeWorktreePath(terminal.worktreePath ?? terminal.cwd)),
      );
      if (
        terminalInPath.some(
          (cwd) => cwd === canonicalPath || cwd.startsWith(canonicalPath + path.sep),
        )
      ) {
        return "a terminal subprocess is running in this worktree";
      }
      if (
        Option.isSome(yield* findCanonicalActiveWorktreeOwner(readModel, threadId, canonicalPath))
      ) {
        return REASON_TEXT["active-worktree-owner"]!;
      }
      const clean = yield* git
        .isWorktreeCleanForRemoval(canonicalPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!clean) return REASON_TEXT["dirty-worktree"]!;
      if (
        thread.archivedAt === null &&
        !(yield* reactor.isIdleReclaimEligibleIgnoringAge(threadId))
      ) {
        return "chat is still in use (provider session, collaboration request or workspace owner)";
      }
      return null;
    });

  const plan: StorageCleanupContributor["plan"] = (_policy, mode) =>
    Effect.gen(function* () {
      // Archive cleanup runs automatically from its durable job reactor.
      if (mode !== "reset") return [];
      const readModel = yield* engine.getReadModel();
      const seenPaths = new Set<string>();
      const candidates: Array<{
        threadId: ThreadId;
        title: string;
        archived: boolean;
        canonicalPath: string;
      }> = [];
      for (const thread of readModel.threads) {
        if (thread.deletedAt !== null || !thread.worktreePath || !thread.branch) {
          continue;
        }
        const canonicalPath = yield* Effect.promise(() =>
          canonicalizeWorktreePath(thread.worktreePath!),
        );
        if (seenPaths.has(canonicalPath)) continue;
        seenPaths.add(canonicalPath);
        candidates.push({
          threadId: thread.id,
          title: thread.title,
          archived: thread.archivedAt !== null,
          canonicalPath,
        });
      }
      const worktreeEntries = yield* Effect.forEach(
        candidates,
        (candidate) =>
          worktreeBlocker(candidate.threadId).pipe(
            Effect.flatMap((blocker) =>
              blocker !== null
                ? Effect.succeed([])
                : sizeOf(candidate.canonicalPath).pipe(
                    Effect.map(
                      (bytes): Array<StoragePlanEntry<WorktreePayload>> => [
                        {
                          item: {
                            id: `worktree:${candidate.threadId}`,
                            category: "worktrees",
                            description: candidate.archived
                              ? `Worktree of archived chat "${candidate.title}"`
                              : `Worktree of idle chat "${candidate.title}"`,
                            target: candidate.canonicalPath,
                            estimatedBytes: bytes,
                            defaultSelected: true,
                            needsManualReview: false,
                          },
                          payload: {
                            kind: "worktree",
                            threadId: candidate.threadId,
                            path: candidate.canonicalPath,
                          },
                        },
                      ],
                    ),
                  ),
            ),
          ),
        { concurrency: MEASURE_CONCURRENCY },
      );

      const trash = yield* trashDirectories;
      const trashEntries = yield* Effect.promise(async () =>
        (await Promise.all(trash.map(listDirectories))).flat(),
      );
      const trashItems = yield* Effect.forEach(
        trashEntries,
        (entry) =>
          sizeOf(entry).pipe(
            Effect.map(
              (bytes): StoragePlanEntry<WorktreePayload> => ({
                item: {
                  id: `trash:${entry}`,
                  category: "worktreeTrash",
                  description: "Detached worktree waiting to be deleted",
                  target: entry,
                  estimatedBytes: bytes,
                  defaultSelected: true,
                  needsManualReview: false,
                },
                payload: { kind: "trash", path: entry },
              }),
            ),
          ),
        { concurrency: MEASURE_CONCURRENCY },
      );
      return [...worktreeEntries.flat(), ...trashItems];
    });

  const executeOne = (entry: StoragePlanEntry) =>
    Effect.gen(function* () {
      const payload = entry.payload as WorktreePayload;
      const result = (
        status: StorageCleanupItemResult["status"],
        reason: string | null,
      ): StorageCleanupItemResult => ({
        itemId: entry.item.id,
        category: entry.item.category,
        description: entry.item.description,
        status,
        bytesFreed: status === "removed" ? entry.item.estimatedBytes : 0,
        reason,
      });
      if (payload.kind === "trash") {
        if (path.basename(path.dirname(payload.path)) !== TRASH_DIRECTORY_NAME) {
          return result("skipped", "not inside a worktree trash directory");
        }
        if (!(yield* Effect.promise(() => pathExists(payload.path)))) {
          return result("skipped", "already deleted");
        }
        yield* Effect.promise(() =>
          fs.rm(payload.path, { recursive: true, force: true, maxRetries: 3 }),
        );
        sizeCache.delete(payload.path);
        return result("removed", "detached worktree in trash");
      }
      const blocker = yield* worktreeBlocker(payload.threadId);
      if (blocker !== null) return result("skipped", blocker);
      const outcome = yield* reactor.reclaimWorktreeNow(payload.threadId);
      if (outcome.status === "skipped") {
        return result("skipped", REASON_TEXT[outcome.reason] ?? outcome.reason);
      }
      sizeCache.delete(payload.path);
      return result("removed", "worktree reclaimed; restores on the chat's next message");
    });

  return {
    id: "worktrees",
    categories: ["worktrees", "worktreeTrash"],
    measure,
    plan,
    execute: (entries) => Effect.forEach(entries, executeOne, { concurrency: 1 }),
  } satisfies StorageCleanupContributor;
});
