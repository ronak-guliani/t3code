import {
  CommandId,
  PullRequestMonitorFeedbackDeliveryId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Option, Result, Schema, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { automaticPrFeedbackBlockReason } from "@t3tools/shared/automaticPrFeedback";
import {
  feedbackStableKeyOf,
  reconcileFeedbackItem,
} from "../../pullRequestMonitor/feedbackReconciliation.ts";
import { PullRequestMonitorFeedbackService } from "../../pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { computeReadiness } from "../../pullRequestMonitor/readiness.ts";
import { buildWakePrompt } from "../../pullRequestMonitor/wakePrompt.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";
import {
  CHILD_DECISION_BLOCKED_DETAIL,
  isThreadReadyForQueuedDispatch,
} from "../commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { isAutomaticChildNudgeBlocked } from "../childNudging.ts";
import { childWaitIsSatisfied, evaluateChildFollowUp } from "@t3tools/shared/childFollowUp";

const MONITOR_REVALIDATION_RETRY_INTERVAL = Duration.seconds(20);
const MAX_MONITOR_REVALIDATION_ATTEMPTS = 3;
const MONITOR_REVALIDATION_RETRY_BASE_MS = 20_000;

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

// A dispatch rejected by the decider's child-decision invariant (see
// CHILD_DECISION_BLOCKED_DETAIL in commandInvariants.ts) is a transient
// ordering conflict, not a permanent failure: the turn must wait until the
// decision is resolved. Match the typed invariant error rather than rendered
// text so message-format changes cannot silently revert to failing turns.
const isChildDecisionBlockedCause = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  return (
    isInvariantError(failure) &&
    failure.commandType === "thread.queued-turn.dispatch" &&
    failure.detail === CHILD_DECISION_BLOCKED_DETAIL
  );
};

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function threadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function canChangeQueuedTurnReadiness(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.child-lifecycle-notified":
    case "thread.turn-diff-completed":
      return false;
    default:
      return event.aggregateKind === "thread";
  }
}

const makeQueuedTurnReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const pullRequests = yield* PullRequestService;
  const monitorFeedback = yield* PullRequestMonitorFeedbackService;
  const serverSettings = yield* ServerSettingsService;
  const wakeScope = yield* Effect.scope;
  const drainingThreadIds = new Set<string>();
  const pendingThreadIds = new Set<ThreadId>();
  const scheduledChildWakes = new Set<string>();

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
      pendingThreadIds.add(threadId);
      return;
    }
    drainingThreadIds.add(threadId);
    try {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const wait = thread.nudging?.wait;
      if (
        wait?.deadlineAt &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !wait.satisfiedAt &&
        !childWaitIsSatisfied(wait) &&
        wait.assignments.some((assignment) => assignment.outcome === undefined)
      ) {
        if (Date.parse(wait.deadlineAt) <= Date.now()) {
          yield* orchestrationEngine.dispatch({
            type: "thread.child-wait.deadline-expire",
            commandId: serverCommandId("child-wait.deadline-expire"),
            threadId,
            expectedDeadlineAt: wait.deadlineAt,
            expiredAt: new Date().toISOString(),
          });
          return;
        }
        yield* scheduleChildWake(threadId, wait.deadlineAt, "wait-deadline");
      }
      const queuedTurns = thread?.queuedTurns ?? [];
      if (queuedTurns.length === 0 || !isThreadReadyForQueuedDispatch(thread)) {
        return;
      }

      const threadsById = new Map(
        queuedTurns.some((turn) => turn.origin?.kind === "child-nudge")
          ? readModel.threads.map((entry) => [entry.id, entry] as const)
          : [],
      );
      const nowIso = new Date().toISOString();
      const eligibleTurns = [];
      for (const turn of queuedTurns) {
        if (turn.origin?.kind !== "child-nudge") {
          eligibleTurns.push(turn);
          continue;
        }
        if (turn.failedAt !== null) continue;
        const followUp = evaluateChildFollowUp(thread, turn, threadsById, nowIso);
        if (followUp.dueAt) {
          yield* scheduleChildWake(threadId, followUp.dueAt, "collection");
        }
        if (!followUp.reason) eligibleTurns.push(turn);
      }
      eligibleTurns.sort((left, right) => {
        const leftUser = left.origin === undefined ? 0 : 1;
        const rightUser = right.origin === undefined ? 0 : 1;
        return leftUser - rightUser || left.createdAt.localeCompare(right.createdAt);
      });
      let nextQueuedTurn = eligibleTurns[0];
      if (eligibleTurns.some((turn) => turn.origin?.kind === "pull-request-monitor")) {
        const settings = yield* serverSettings.getSettings;
        nextQueuedTurn = eligibleTurns.find(
          (turn) =>
            turn.failedAt !== null ||
            turn.origin?.kind !== "pull-request-monitor" ||
            automaticPrFeedbackBlockReason(
              settings,
              turn.modelSelection?.instanceId ?? thread.modelSelection.instanceId,
              thread.session,
            ) === null,
        );
      }
      if (!nextQueuedTurn || nextQueuedTurn.failedAt !== null) return;

      // While a child decision is pending, only its correlated decision
      // response may dispatch. Anything else stays queued (waiting) so the
      // user can resolve the decision first; failing it here would turn a
      // transient ordering conflict into a permanent Paused error. A queued
      // response still jumps ahead of unrelated waiting turns.
      // Note the decider clears `decision` atomically when it creates
      // `pendingResponse`, so gate the fast-path on the response itself: a
      // real answer exists as `decision: null` plus `pendingResponse` set.
      const activeDelegation =
        thread.nudging?.delegation?.completedAt === null ? thread.nudging.delegation : undefined;
      const pendingResponseId = activeDelegation?.pendingResponse?.queuedTurnId ?? null;
      if (pendingResponseId !== null) {
        const responseTurn = eligibleTurns.find(
          (turn) => turn.id === pendingResponseId && turn.failedAt === null,
        );
        if (!responseTurn) return;
        nextQueuedTurn = responseTurn;
      } else if (activeDelegation?.decision) {
        return;
      }

      const blockedByCollaborationWait = (thread.collaborationRequests ?? []).some(
        (request) =>
          request.senderThreadId === thread.id && request.blocking && request.status === "waiting",
      );
      if (
        blockedByCollaborationWait &&
        nextQueuedTurn.origin?.kind !== "collaboration-response" &&
        nextQueuedTurn.origin !== undefined
      ) {
        return;
      }

      const origin = nextQueuedTurn.origin;
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
                  ...(origin.findingContext === undefined
                    ? {}
                    : { findingContext: origin.findingContext }),
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
              if (isChildDecisionBlockedCause(cause)) {
                // Race: a child decision landed between the read model snapshot
                // and dispatch. Leave the turn queued; the meta-updated event
                // for the delegation change (or the next drain) retries it
                // after the decision is resolved.
                yield* Effect.logWarning("queued turn dispatch waiting on child decision", {
                  threadId,
                  queuedTurnId: nextQueuedTurn.id,
                });
                return;
              }
              const latestReadModel = yield* orchestrationEngine.getReadModel();
              const latestThread = latestReadModel.threads.find((entry) => entry.id === threadId);
              if (
                !latestThread ||
                !isThreadReadyForQueuedDispatch(latestThread) ||
                (nextQueuedTurn.origin?.kind === "child-nudge" &&
                  (isAutomaticChildNudgeBlocked(latestThread) ||
                    evaluateChildFollowUp(
                      latestThread,
                      nextQueuedTurn,
                      new Map(latestReadModel.threads.map((entry) => [entry.id, entry])),
                      new Date().toISOString(),
                    ).reason !== null))
              ) {
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
      if (pendingThreadIds.delete(threadId)) {
        yield* drainThreadSafely(threadId).pipe(Effect.forkIn(wakeScope));
      }
    }
  });

  const drainThreadSafely = (threadId: ThreadId): Effect.Effect<void> =>
    drainThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to drain thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const scheduleChildWake = (
    threadId: ThreadId,
    dueAt: string,
    kind: "collection" | "wait-deadline",
  ): Effect.Effect<void> => {
    const key = `${kind}:${threadId}:${dueAt}`;
    if (scheduledChildWakes.has(key)) return Effect.void;
    scheduledChildWakes.add(key);
    return Effect.sleep(Duration.millis(Math.max(0, Date.parse(dueAt) - Date.now()))).pipe(
      Effect.andThen(Effect.suspend(() => drainThreadSafely(threadId))),
      Effect.ensuring(Effect.sync(() => scheduledChildWakes.delete(key))),
      Effect.forkIn(wakeScope),
      Effect.asVoid,
    );
  };

  const drainQueuedThreads = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter((thread) => {
        const wait = thread.nudging?.wait;
        return (
          (thread.queuedTurns ?? []).length > 0 ||
          (wait?.deadlineAt !== undefined &&
            !wait.satisfiedAt &&
            !childWaitIsSatisfied(wait) &&
            wait.assignments.some((assignment) => assignment.outcome === undefined))
        );
      }),
      (thread) => drainThreadSafely(thread.id).pipe(Effect.forkScoped),
      { concurrency: 1 },
    );
  });

  const start: QueuedTurnReactorShape["start"] = Effect.fn("start")(function* () {
    yield* drainQueuedThreads;

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!canChangeQueuedTurnReadiness(event)) return Effect.void;
        const threadId = threadIdForEvent(event);
        if (threadId === null) return Effect.void;
        return Effect.gen(function* () {
          yield* drainThreadSafely(threadId);
          if (
            event.type === "thread.meta-updated" ||
            event.type === "thread.archived" ||
            event.type === "thread.deleted" ||
            event.type === "thread.decoupled" ||
            event.type === "thread.queued-turn-created" ||
            event.type === "thread.queued-turn-updated"
          ) {
            const state = yield* orchestrationEngine.getReadModel();
            const parentId = state.threads.find((thread) => thread.id === threadId)?.parentThreadId;
            if (parentId) yield* drainThreadSafely(parentId);
          }
        });
      }),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, () => drainQueuedThreads),
    );
    // Keep this sweep: PR-monitor revalidation retries also depend on it.
    yield* Effect.forkScoped(
      Effect.sleep(MONITOR_REVALIDATION_RETRY_INTERVAL).pipe(
        Effect.andThen(drainQueuedThreads),
        Effect.forever,
      ),
    );
  });

  return {
    start,
    wakeThread: (threadId) => drainThreadSafely(threadId as ThreadId),
  } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, makeQueuedTurnReactor);
