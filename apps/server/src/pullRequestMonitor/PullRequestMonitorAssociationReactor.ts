import { type OrchestrationEvent, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

interface AssociatedPullRequest {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}

/** `https://host/owner/name/pull/123` → `owner/name`. */
export function repositoryFromPullRequestUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const segments = new URL(url).pathname.replace(/^\/+/, "").split("/");
    const owner = segments[0];
    const name = segments[1];
    return owner && name ? `${owner}/${name}` : null;
  } catch {
    return null;
  }
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
    repository,
    number: pullRequest.number,
  };
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
      const projectId =
        association.projectId.length > 0
          ? association.projectId
          : yield* Effect.map(engine.getReadModel(), (readModel) => {
              const thread = readModel.threads.find((entry) => entry.id === association.threadId);
              return (thread?.projectId ?? null) as ProjectId | null;
            });
      if (projectId === null || projectId.length === 0) return;
      yield* monitors
        .start({
          projectId,
          repository: association.repository,
          number: association.number,
          ownerThreadId: association.threadId,
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
