import { Clock, Context, Effect, FileSystem, Layer, PubSub, Ref, Stream } from "effect";
import type { Scope } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { GitCore, type GitStatusDetails } from "./Services/GitCore.ts";

function autoPullSkipReason(status: GitStatusDetails): string | null {
  if (!status.isRepo) return "not-a-repository";
  if (!status.isDefaultBranch) return "not-default-branch";
  if (!status.hasUpstream) return "no-upstream";
  if (status.hasWorkingTreeChanges) return "local-changes";
  if (status.aheadCount > 0) return "local-commits";
  if (status.behindCount <= 0) return "up-to-date";
  return null;
}

export class ProjectAutoPull extends Context.Service<
  ProjectAutoPull,
  {
    readonly attempt: (cwd: string) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly changes: Stream.Stream<string>;
  }
>()("t3/git/ProjectAutoPull") {}

export const ProjectAutoPullLive = Layer.effect(
  ProjectAutoPull,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitCore;
    const fs = yield* FileSystem.FileSystem;
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const busy = yield* Ref.make(new Set<string>());
    const failures = new Map<string, { count: number; retryAt: number }>();

    const enabledRoots = Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      return model.projects
        .filter((project) => !project.deletedAt && project.autoPull === true)
        .map((project) => project.workspaceRoot);
    });

    const eligible = (cwd: string) =>
      Effect.gen(function* () {
        const model = yield* engine.getReadModel();
        let enabled = false;
        for (const project of model.projects) {
          if (project.deletedAt || project.autoPull !== true) continue;
          const root = yield* fs.realPath(project.workspaceRoot).pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.logWarning("Automatic pull project path unavailable", {
                projectId: project.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (root === cwd) {
            enabled = true;
            break;
          }
        }
        if (!enabled) return false;
        for (const thread of model.threads) {
          if (
            thread.latestTurn?.state !== "running" &&
            !thread.session?.activeTurnId &&
            !(thread.queuedTurns ?? []).some((turn) => turn.failedAt === null)
          )
            continue;
          const project = model.projects.find((entry) => entry.id === thread.projectId);
          const path = thread.worktreePath ?? project?.workspaceRoot;
          // An unresolved active owner is not evidence that the checkout is idle.
          if (!path || (yield* fs.realPath(path)) === cwd) return false;
        }
        return true;
      });

    const head = (cwd: string) =>
      git
        .execute({
          operation: "ProjectAutoPull.head",
          cwd,
          args: ["rev-parse", "HEAD"],
        })
        .pipe(Effect.map((result) => result.stdout.trim()));

    const pull = (cwd: string) =>
      Effect.gen(function* () {
        if (!(yield* eligible(cwd))) return;
        const status = yield* git.statusDetails(cwd);
        const reason = autoPullSkipReason(status);
        if (reason) {
          yield* Effect.logDebug("Automatic project pull skipped", { cwd, reason });
          return;
        }
        const expectedHead = yield* head(cwd);
        const current = yield* git.statusDetailsLocal(cwd);
        // User status preferences can hide untracked files or submodule changes.
        const workingTree = yield* git.execute({
          operation: "ProjectAutoPull.workingTree",
          cwd,
          args: ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
        });
        if (
          autoPullSkipReason(current) ||
          workingTree.stdout.trim().length > 0 ||
          current.branch !== status.branch ||
          current.upstreamRef !== status.upstreamRef ||
          (yield* head(cwd)) !== expectedHead ||
          !(yield* eligible(cwd))
        )
          return;

        // External terminals do not share our reservation; Git remains the final
        // authority and must never merge, rebase, stash, or reset local work.
        yield* git.execute({
          operation: "ProjectAutoPull.pull",
          cwd,
          args: [
            "-c",
            "merge.autostash=false",
            "-c",
            "rebase.autoStash=false",
            "pull",
            "--ff-only",
          ],
          timeoutMs: 30_000,
        });
        yield* PubSub.publish(changes, cwd);
      });

    const attempt = (rawCwd: string) =>
      Effect.gen(function* () {
        // Avoid filesystem or Git work when the feature is off everywhere.
        if ((yield* enabledRoots).length === 0) return;
        const cwd = yield* fs.realPath(rawCwd);
        const now = yield* Clock.currentTimeMillis;
        if ((failures.get(cwd)?.retryAt ?? 0) > now) return;
        yield* Effect.acquireUseRelease(
          Ref.modify(busy, (paths) =>
            paths.has(cwd) ? [false, paths] : [true, new Set([...paths, cwd])],
          ),
          (acquired) =>
            acquired
              ? pull(cwd).pipe(
                  Effect.tap(() => Effect.sync(() => failures.delete(cwd))),
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      const count = (failures.get(cwd)?.count ?? 0) + 1;
                      const failedAt = yield* Clock.currentTimeMillis;
                      failures.set(cwd, {
                        count,
                        retryAt: failedAt + Math.min(30_000 * 2 ** (count - 1), 300_000),
                      });
                      yield* Effect.logWarning("Automatic project pull failed", { cwd, cause });
                    }),
                  ),
                )
              : Effect.void,
          (acquired) =>
            acquired
              ? Ref.update(busy, (paths) => {
                  const next = new Set(paths);
                  next.delete(cwd);
                  return next;
                })
              : Effect.void,
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull lookup failed", { cause }),
        ),
      );

    const start = Effect.gen(function* () {
      const subscription = yield* engine.acquireDomainEventSubscription;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (event) => event.type === "project.meta-updated" && event.payload.autoPull === true,
        ),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const model = yield* engine.getReadModel();
            const project = model.projects.find((entry) => entry.id === event.aggregateId);
            if (project) yield* attempt(project.workspaceRoot);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.forEach(yield* enabledRoots, attempt, { concurrency: 4, discard: true });
    });

    return { attempt, start, changes: Stream.fromPubSub(changes) };
  }),
);
