import {
  CommandId,
  PullRequestMonitorFeedbackDeliveryId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Result, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { allowsAutomaticPrFeedback } from "../../pullRequestMonitor/automaticFeedback.ts";
import {
  feedbackStableKeyOf,
  reconcileFeedbackItem,
} from "../../pullRequestMonitor/feedbackReconciliation.ts";
import { PullRequestMonitorFeedbackService } from "../../pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { computeReadiness } from "../../pullRequestMonitor/readiness.ts";
import { buildWakePrompt } from "../../pullRequestMonitor/wakePrompt.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";
import { isThreadReadyForQueuedDispatch } from "../commandInvariants.ts";

const MONITOR_REVALIDATION_RETRY_INTERVAL = Duration.seconds(20);
const MAX_MONITOR_REVALIDATION_ATTEMPTS = 3;
const MONITOR_REVALIDATION_RETRY_BASE_MS = 20_000;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function threadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

const makeQueuedTurnReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const pullRequests = yield* PullRequestService;
  const monitorFeedback = yield* PullRequestMonitorFeedbackService;
  const serverSettings = yield* ServerSettingsService;
  const drainingThreadIds = new Set<string>();

  const failQueuedTurn = (input: {
    readonly threadId: ThreadId;
    readonly queuedTurnId: QueuedTurnId;
    readonly detail: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.queued-turn.fail",
      commandId: serverCommandId("queued-turn.fail"),
      threadId: input.threadId,
      queuedTurnId: input.queuedTurnId,
      failureMessage: input.detail.length > 0 ? input.detail : "Failed to dispatch queued message.",
      failedAt: new Date().toISOString(),
    });

  const drainThread = Effect.fn("QueuedTurnReactor.drainThread")(function* (threadId: ThreadId) {
    if (drainingThreadIds.has(threadId)) {
      return;
    }
    drainingThreadIds.add(threadId);
    try {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      const queuedTurns = thread?.queuedTurns ?? [];
      if (!thread || queuedTurns.length === 0 || !isThreadReadyForQueuedDispatch(thread)) {
        return;
      }

      const nextQueuedTurn = queuedTurns[0];
      if (!nextQueuedTurn || nextQueuedTurn.failedAt !== null) {
        return;
      }

      const origin = nextQueuedTurn.origin;
      if (origin?.kind === "pull-request-monitor") {
        const settings = yield* serverSettings.getSettings;
        const instanceId =
          nextQueuedTurn.modelSelection?.instanceId ?? thread.modelSelection.instanceId;
        if (!allowsAutomaticPrFeedback(settings, instanceId)) {
          yield* failQueuedTurn({
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            detail:
              "Automatic PR feedback is paused for Copilot ACP: a completed prompt may still have background work running. Sending feedback can interrupt that work. Review the session first. To resume automatic delivery, enable it in this provider's settings, then edit and save this queued message. This containment does not fix background completion or checkpoints.",
          });
          return;
        }
      }
      if (origin?.kind === "pull-request-monitor" && origin.headSha !== undefined) {
        const observedHeadSha = origin.headSha;
        const now = new Date();
        if (
          origin.nextRevalidationAt !== undefined &&
          origin.nextRevalidationAt > now.toISOString()
        ) {
          return;
        }
        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: thread.projectId,
            repository: origin.repository,
            number: origin.number,
          }),
        );
        if (Result.isFailure(snapshotResult)) {
          const attemptCount = (origin.revalidationAttemptCount ?? 0) + 1;
          yield* Effect.logWarning("could not revalidate queued PR monitor turn", {
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            repository: origin.repository,
            pullRequestNumber: origin.number,
            attemptCount,
            cause: snapshotResult.failure,
          });
          if (attemptCount >= MAX_MONITOR_REVALIDATION_ATTEMPTS) {
            if (origin.deliveryId === undefined) {
              yield* Effect.logWarning("queued PR monitor turn has no durable delivery to retry", {
                threadId,
                queuedTurnId: nextQueuedTurn.id,
                repository: origin.repository,
                pullRequestNumber: origin.number,
              });
              return;
            }
            yield* monitorFeedback.retryQueuedDelivery({
              deliveryId: PullRequestMonitorFeedbackDeliveryId.make(origin.deliveryId),
              reason: "Queued dispatch revalidation failed repeatedly.",
            });
            yield* orchestrationEngine.dispatch({
              type: "thread.queued-turn.delete",
              commandId: serverCommandId("queued-turn.delete-monitor-revalidation-failed"),
              threadId,
              queuedTurnId: nextQueuedTurn.id,
              deletedAt: now.toISOString(),
            });
            return;
          }
          const retryDelayMs =
            MONITOR_REVALIDATION_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.update",
            commandId: serverCommandId("queued-turn.defer-monitor-revalidation"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            text: nextQueuedTurn.message.text,
            origin: {
              ...origin,
              revalidationAttemptCount: attemptCount,
              nextRevalidationAt: new Date(now.getTime() + retryDelayMs).toISOString(),
            },
            updatedAt: now.toISOString(),
          });
          return;
        }
        const snapshot = snapshotResult.success;
        const sourceRevisionChanged =
          origin.sourceRevision !== undefined && snapshot.sourceRevision !== origin.sourceRevision;
        const providerStateChanged = snapshot.headSha !== origin.headSha || sourceRevisionChanged;
        const actionableEvents =
          origin.events?.filter(
            (event) =>
              reconcileFeedbackItem(
                { kind: event.kind, stableKey: feedbackStableKeyOf(event) },
                snapshot,
                {
                  checkName: event.kind === "check-failed" ? (event.detail ?? null) : null,
                  observedHeadSha,
                },
              ).kind === "actionable",
          ) ?? [];
        if (
          snapshot.state !== "open" ||
          (providerStateChanged &&
            origin.events !== undefined &&
            origin.events.length > 0 &&
            actionableEvents.length === 0)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.delete",
            commandId: serverCommandId("queued-turn.delete-stale-monitor"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            deletedAt: new Date().toISOString(),
          });
          return;
        }

        const hadRevalidationFailure =
          origin.revalidationAttemptCount !== undefined || origin.nextRevalidationAt !== undefined;
        if (providerStateChanged || hadRevalidationFailure) {
          const {
            revalidationAttemptCount: _revalidationAttemptCount,
            nextRevalidationAt: _nextRevalidationAt,
            ...stableOrigin
          } = origin;
          const refreshedOrigin = {
            ...stableOrigin,
            headSha: snapshot.headSha,
            sourceRevision: snapshot.sourceRevision,
            ...(origin.events === undefined ? {} : { events: actionableEvents }),
          };
          const refreshedText =
            providerStateChanged && origin.deliveryId !== undefined
              ? buildWakePrompt({
                  prNumber: origin.number,
                  repository: origin.repository,
                  deliveryId: origin.deliveryId,
                  events: actionableEvents,
                  ...((origin.events === undefined || origin.events.length === 0) &&
                  origin.revisionSummaries !== undefined
                    ? { revisionSummaries: origin.revisionSummaries }
                    : {}),
                  snapshot,
                  readiness: computeReadiness(snapshot),
                  ...(origin.availableTools === undefined
                    ? {}
                    : { availableTools: origin.availableTools }),
                })
              : nextQueuedTurn.message.text;
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.update",
            commandId: serverCommandId("queued-turn.refresh-monitor"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            text: refreshedText,
            origin: refreshedOrigin,
            updatedAt: now.toISOString(),
          });
        }
      }

      const dispatchedAt = new Date().toISOString();
      yield* orchestrationEngine
        .dispatch({
          type: "thread.queued-turn.dispatch",
          commandId: serverCommandId("queued-turn.dispatch"),
          threadId,
          queuedTurnId: nextQueuedTurn.id,
          dispatchedAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const latestReadModel = yield* orchestrationEngine.getReadModel();
              const latestThread = latestReadModel.threads.find((entry) => entry.id === threadId);
              if (!latestThread || !isThreadReadyForQueuedDispatch(latestThread)) {
                return;
              }
              yield* failQueuedTurn({
                threadId,
                queuedTurnId: nextQueuedTurn.id,
                detail: Cause.pretty(cause),
              }).pipe(
                Effect.catchCause((failCause) =>
                  Effect.logWarning("failed to mark queued turn as failed", {
                    threadId,
                    queuedTurnId: nextQueuedTurn.id,
                    cause: Cause.pretty(failCause),
                  }),
                ),
              );
            }),
          ),
        );
    } finally {
      drainingThreadIds.delete(threadId);
    }
  });

  const drainThreadSafely = (threadId: ThreadId) =>
    drainThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to drain thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const drainQueuedThreads = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter((thread) => (thread.queuedTurns ?? []).length > 0),
      (thread) => drainThreadSafely(thread.id).pipe(Effect.forkScoped),
      { concurrency: 1 },
    );
  });

  const start: QueuedTurnReactorShape["start"] = Effect.fn("start")(function* () {
    yield* drainQueuedThreads;

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = threadIdForEvent(event);
        return threadId === null ? Effect.void : drainThreadSafely(threadId);
      }),
    );
    yield* Effect.forkScoped(
      Effect.sleep(MONITOR_REVALIDATION_RETRY_INTERVAL).pipe(
        Effect.andThen(drainQueuedThreads),
        Effect.forever,
      ),
    );
  });

  return { start } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, makeQueuedTurnReactor);
