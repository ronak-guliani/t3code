import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  threadHasInFlightTurn,
  threadHasPendingInteraction,
} from "../orchestration/commandInvariants.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { CollaborativeAcceptanceCoordinator } from "../collaborativeAcceptance/Coordinator.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

const RECONCILIATION_INTERVAL = "30 seconds";

export interface CreatedPullRequestReviewObservation {
  readonly state: "open" | "closed" | "merged";
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly sourceRevision: string;
}

export interface CreatedPullRequestReviewReconciliation {
  readonly runExclusive?: (
    link: ThreadPullRequestLink,
    effect: Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, unknown>;
  readonly refresh: (
    link: ThreadPullRequestLink,
  ) => Effect.Effect<CreatedPullRequestReviewObservation | null, unknown>;
  readonly readCurrentThread: () => Effect.Effect<OrchestrationThread | null>;
  readonly submit: (input: {
    readonly thread: OrchestrationThread;
    readonly link: ThreadPullRequestLink;
    readonly observation: CreatedPullRequestReviewObservation;
  }) => Effect.Effect<void, unknown>;
}

export function createdPullRequestLinks(
  thread: Pick<OrchestrationThread, "pullRequests">,
): ReadonlyArray<ThreadPullRequestLink> {
  return (thread.pullRequests ?? []).filter(
    (link) => link.source === "created" || link.source === "agent",
  );
}

export function creatorIsInactive(thread: OrchestrationThread): boolean {
  return !threadHasInFlightTurn(thread) && !threadHasPendingInteraction(thread);
}

export interface ReferenceCountedKeyedLock {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly size: () => number;
}

export function makeReferenceCountedKeyedLock(): ReferenceCountedKeyedLock {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users += 1;
          locks.set(key, entry);
          return entry;
        }),
        (entry) => entry.semaphore.withPermit(effect),
        (entry) =>
          Effect.sync(() => {
            if (locks.get(key) !== entry) return;
            entry.users -= 1;
            if (entry.users === 0) locks.delete(key);
          }),
      ),
    size: () => locks.size,
  };
}

export const reconcileCreatedPullRequestReview = (
  thread: OrchestrationThread,
  reconciliation: CreatedPullRequestReviewReconciliation,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (thread.deletedAt !== null || thread.archivedAt !== null || !creatorIsInactive(thread)) {
      return;
    }

    for (const link of createdPullRequestLinks(thread)) {
      const reconcileLink = Effect.gen(function* () {
        const observation = yield* reconciliation.refresh(link);
        if (observation === null || observation.state !== "open") return;

        const latestThread = yield* reconciliation.readCurrentThread();
        if (
          latestThread === null ||
          latestThread.deletedAt !== null ||
          latestThread.archivedAt !== null ||
          !creatorIsInactive(latestThread) ||
          !createdPullRequestLinks(latestThread).some(
            (candidate) =>
              candidate.source === link.source &&
              pullRequestKey(candidate) === pullRequestKey(link),
          )
        ) {
          return;
        }

        yield* reconciliation.submit({
          thread: latestThread,
          link,
          observation,
        });
      });
      yield* reconciliation.runExclusive?.(link, reconcileLink) ?? reconcileLink;
    }
  });

function threadIdFromEvent(event: OrchestrationEvent): OrchestrationThread["id"] | null {
  if (event.aggregateKind !== "thread") return null;
  return event.aggregateId as OrchestrationThread["id"];
}

const pullRequestKey = (link: ThreadPullRequestLink): string =>
  `${link.pullRequest.url}:${link.pullRequest.number}`;

const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const acceptance = yield* CollaborativeAcceptanceCoordinator;
  const pullRequestLocks = makeReferenceCountedKeyedLock();

  const currentThread = (threadId: OrchestrationThread["id"]) =>
    Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      return readModel.threads.find((thread) => thread.id === threadId) ?? null;
    });

  const reconcileThread = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      yield* reconcileCreatedPullRequestReview(thread, {
        runExclusive: (link, effect) =>
          pullRequestLocks.withLock(`${thread.id}:${pullRequestKey(link)}`, effect),
        refresh: (link) => {
          const repository = repositoryFromPullRequestUrl(link.pullRequest.url);
          if (repository === null) return Effect.succeed(null);
          return Effect.gen(function* () {
            const refreshed = yield* monitors.start({
              projectId: thread.projectId,
              repository,
              number: link.pullRequest.number,
              ownerThreadId: thread.id,
              ownerMode: "preserve",
            });
            const context = yield* monitors.context({ monitorId: refreshed.monitor.id });
            const snapshot = context.latestSnapshot;
            return snapshot === null
              ? null
              : {
                  state: snapshot.state,
                  repository: snapshot.repository,
                  number: snapshot.number,
                  headSha: snapshot.headSha,
                  sourceRevision: snapshot.sourceRevision,
                };
          });
        },
        readCurrentThread: () => currentThread(thread.id),
        submit: ({ thread: latestThread, observation }) =>
          acceptance
            .reconcileAutomaticCandidate({
              parentThreadId: latestThread.id,
              pullRequest: {
                projectId: latestThread.projectId,
                repository: observation.repository,
                number: observation.number,
              },
              headSha: observation.headSha,
              sourceRevision: observation.sourceRevision,
            })
            .pipe(Effect.asVoid),
      });
    });

  const reconcileThreadSafely = (thread: OrchestrationThread) =>
    reconcileThread(thread).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("created pull-request review reconciliation failed", {
          threadId: thread.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reconcileAll = Effect.gen(function* () {
    const readModel: OrchestrationReadModel = yield* engine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          createdPullRequestLinks(thread).length > 0 &&
          creatorIsInactive(thread),
      ),
      reconcileThreadSafely,
      { concurrency: 2, discard: true },
    );
  });

  const subscription = yield* engine.acquireDomainEventSubscription;
  yield* reconcileAll;

  yield* Effect.forkScoped(
    Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
      Stream.runForEach((event) => {
        const threadId = threadIdFromEvent(event);
        if (threadId === null) return Effect.void;
        return currentThread(threadId).pipe(
          Effect.flatMap((thread) =>
            thread === null ? Effect.void : reconcileThreadSafely(thread),
          ),
        );
      }),
    ),
  );
  yield* Effect.forkScoped(
    reconcileAll.pipe(Effect.repeat(Schedule.spaced(RECONCILIATION_INTERVAL))),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
