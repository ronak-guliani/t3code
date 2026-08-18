import { type OrchestrationEvent, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

export { repositoryFromPullRequestUrl } from "./canonicalKey.ts";

export interface AssociatedPullRequest {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly source: "thread-created" | "thread-meta-updated";
  readonly repository: string;
  readonly number: number;
}

/**
 * Pull the durable association out of a lifecycle event. Only events that actually carry a
 * pull request qualify: a metadata update that leaves the association untouched must not
 * restart monitoring.
 */
export function associationFromEvent(event: OrchestrationEvent): AssociatedPullRequest | null {
  if (event.aggregateKind !== "thread") return null;
  if (event.type !== "thread.created" && event.type !== "thread.meta-updated") return null;
  const payload = event.payload as {
    readonly threadId?: unknown;
    readonly projectId?: unknown;
    readonly parentThreadId?: unknown;
    readonly pullRequest?: { readonly number?: unknown; readonly url?: unknown } | null;
  };
  const pullRequest = payload.pullRequest;
  if (!pullRequest || typeof pullRequest.number !== "number") return null;
  const repository = repositoryFromPullRequestUrl(
    typeof pullRequest.url === "string" ? pullRequest.url : null,
  );
  if (repository === null) return null;
  const threadId = typeof payload.threadId === "string" ? (payload.threadId as ThreadId) : null;
  if (threadId === null) return null;
  const projectId = typeof payload.projectId === "string" ? (payload.projectId as ProjectId) : null;
  return {
    threadId,
    projectId: projectId ?? ("" as ProjectId),
    parentThreadId:
      event.type === "thread.created" && typeof payload.parentThreadId === "string"
        ? (payload.parentThreadId as ThreadId)
        : null,
    source: event.type === "thread.created" ? "thread-created" : "thread-meta-updated",
    repository,
    number: pullRequest.number,
  };
}

/**
 * Workflow/review children inherit their parent's PR metadata when they are created.
 * That inherited metadata keeps the highest active associated ancestor as owner; a later
 * explicit metadata association still transfers ownership to the selected chat.
 */
export function associationOwnerThreadId(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly parentThreadId?: ThreadId | null;
    readonly pullRequest?: { readonly number: number; readonly url: string } | null;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  }>,
  association: AssociatedPullRequest,
  projectId: ProjectId,
  existingOwnerThreadId: ThreadId | null = null,
): ThreadId {
  if (association.source !== "thread-created" || association.parentThreadId === null) {
    return association.threadId;
  }

  const isActiveAssociatedThread = (threadId: ThreadId) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    return (
      thread !== undefined &&
      thread.projectId === projectId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.pullRequest?.number === association.number &&
      repositoryFromPullRequestUrl(thread.pullRequest.url) === association.repository
    );
  };
  if (existingOwnerThreadId !== null && isActiveAssociatedThread(existingOwnerThreadId)) {
    return existingOwnerThreadId;
  }

  let ownerThreadId = association.threadId;
  let parentThreadId: ThreadId | null = association.parentThreadId;
  const visited = new Set<string>([association.threadId]);
  while (parentThreadId !== null && !visited.has(parentThreadId)) {
    visited.add(parentThreadId);
    const parent = threads.find((thread) => thread.id === parentThreadId);
    if (!parent || !isActiveAssociatedThread(parent.id)) {
      break;
    }
    ownerThreadId = parent.id;
    parentThreadId = parent.parentThreadId ?? null;
  }
  return ownerThreadId;
}

/**
 * Auto-start monitoring when a chat becomes a pull request's owner. Association is the
 * ownership signal, so monitoring follows it instead of requiring a separate UI action.
 * Settings gate the behaviour, and a failure here never blocks the association itself.
 */
const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const serverSettings = yield* ServerSettingsService;

  const handle = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const association = associationFromEvent(event);
      if (association === null) return;
      const settings = yield* Effect.result(serverSettings.getSettings);
      if (Result.isFailure(settings) || settings.success.autoMonitorPullRequestsOnCreate !== true) {
        return;
      }
      const readModel = yield* engine.getReadModel();
      const projectId =
        association.projectId.length > 0
          ? association.projectId
          : ((readModel.threads.find((entry) => entry.id === association.threadId)?.projectId ??
              null) as ProjectId | null);
      if (projectId === null || projectId.length === 0) return;
      const existingOwnerThreadId =
        association.source === "thread-created"
          ? yield* monitors.list({ projectId }).pipe(
              Effect.map(
                ({ monitors: records }) =>
                  records.find(
                    (monitor) =>
                      monitor.repository === association.repository &&
                      monitor.number === association.number,
                  )?.ownerThreadId ?? null,
              ),
              Effect.catchTag("PullRequestMonitorError", () => Effect.succeed(null)),
            )
          : null;
      yield* monitors
        .start({
          projectId,
          repository: association.repository,
          number: association.number,
          ownerThreadId: associationOwnerThreadId(
            readModel.threads,
            association,
            projectId,
            existingOwnerThreadId,
          ),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("pr-monitor auto-start skipped", {
              threadId: association.threadId,
              repository: association.repository,
              number: association.number,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    });

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pr-monitor association reactor failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
