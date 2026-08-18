import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
  PullRequestMonitorError,
  PullRequestOperationError,
  type PullRequestMonitorSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { PullRequestMonitorFeedbackService } from "../../pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { QueuedTurnReactorLive } from "./QueuedTurnReactor.ts";

const now = "2026-03-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-queued-startup");
const queuedTurnId = QueuedTurnId.make("queued-turn-startup");

function monitorSnapshot(
  headSha: string,
  sourceRevision = `rev-${headSha}`,
): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    state: "open",
    isDraft: false,
    headSha,
    baseBranch: "main",
    headBranch: "feat/monitor",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Monitor me",
    url: "https://github.com/acme/app/pull/42",
    fetchedAt: now,
    sourceRevision,
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
      baseComparisonKnown: true,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
  };
}

function queuedReadModel(
  queuedTurnOverrides: Partial<OrchestrationQueuedTurn> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Queued startup",
        modelSelection: {
          instanceId: ProviderInstanceId.make("copilot"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/handoff",
        worktreePath: "/tmp/handoff",
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        queuedTurns: [
          {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: MessageId.make("message-startup"),
              role: "user",
              text: "continue after restart",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
            ...queuedTurnOverrides,
          },
        ],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    workflowRuns: [],
    updatedAt: now,
  };
}

function pullRequestLayer(
  snapshot: PullRequestMonitorSnapshot,
  snapshotError?: PullRequestOperationError,
) {
  return Layer.succeed(
    PullRequestService,
    PullRequestService.of({
      list: () => Effect.die("unused"),
      listStats: () => Effect.die("unused"),
      detail: () => Effect.die("unused"),
      activity: () => Effect.die("unused"),
      diff: () => Effect.die("unused"),
      runAction: () => Effect.die("unused"),
      comment: () => Effect.die("unused"),
      submitReview: () => Effect.die("unused"),
      replyToThread: () => Effect.die("unused"),
      setThreadResolution: () => Effect.die("unused"),
      reviewerCandidates: () => Effect.die("unused"),
      requestReviewers: () => Effect.die("unused"),
      invalidate: () => Effect.void,
      monitorSnapshot: () =>
        snapshotError === undefined ? Effect.succeed(snapshot) : Effect.fail(snapshotError),
    }),
  );
}

async function runReactor(
  readModelInput: OrchestrationReadModel,
  snapshot: PullRequestMonitorSnapshot,
  options?: {
    readonly snapshotError?: PullRequestOperationError;
    readonly onRetryQueuedDelivery?: (deliveryId: string) => void;
    readonly retryQueuedDeliveryError?: PullRequestMonitorError;
  },
): Promise<ReadonlyArray<OrchestrationCommand>> {
  let readModel = readModelInput;
  const commands: OrchestrationCommand[] = [];
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        if (
          command.type === "thread.queued-turn.dispatch" ||
          command.type === "thread.queued-turn.delete"
        ) {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId ? { ...thread, queuedTurns: [] } : thread,
            ),
          };
        } else if (command.type === "thread.queued-turn.update") {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    queuedTurns: (thread.queuedTurns ?? []).map((queuedTurn) =>
                      queuedTurn.id === command.queuedTurnId
                        ? {
                            ...queuedTurn,
                            message: { ...queuedTurn.message, text: command.text },
                            ...(command.origin === undefined ? {} : { origin: command.origin }),
                            failedAt: null,
                            failureMessage: null,
                          }
                        : queuedTurn,
                    ),
                  }
                : thread,
            ),
          };
        }
        return { sequence: 2 };
      }),
    withWorktreeLock: (effect) => effect,
    streamDomainEvents: Stream.never,
  });
  const feedbackLayer = Layer.succeed(
    PullRequestMonitorFeedbackService,
    PullRequestMonitorFeedbackService.of({
      reconcileAndIngest: () => Effect.die("unused"),
      readinessSummary: () => Effect.die("unused"),
      ingestFindings: () => Effect.die("unused"),
      flushDueDeliveries: Effect.die("unused"),
      retryQueuedDelivery: ({ deliveryId }) =>
        options?.retryQueuedDeliveryError === undefined
          ? Effect.sync(() => options?.onRetryQueuedDelivery?.(deliveryId))
          : Effect.fail(options.retryQueuedDeliveryError),
      context: () => Effect.die("unused"),
      report: () => Effect.die("unused"),
      listOpenItems: () => Effect.die("unused"),
      listDeliveries: () => Effect.die("unused"),
      listReports: () => Effect.die("unused"),
    }),
  );
  const layer = QueuedTurnReactorLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(pullRequestLayer(snapshot, options?.snapshotError)),
    Layer.provide(feedbackLayer),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* QueuedTurnReactor;
        yield* reactor.start();
        yield* Effect.sleep("10 millis");
      }),
    ).pipe(Effect.provide(layer)),
  );
  return commands;
}

describe("QueuedTurnReactor", () => {
  it("dispatches a persisted continuation exactly once when the server restarts", async () => {
    const commands = await runReactor(queuedReadModel(), monitorSnapshot("head-current"));

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
    expect(commands[0]?.commandId).toEqual(expect.stringMatching(/^server:queued-turn\.dispatch:/));
  });

  it("deletes a stale PR monitor turn instead of dispatching it", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
        },
      }),
      monitorSnapshot("head-current", "revision-new"),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("suppresses a failed check from an older head while its rerun is pending", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-old",
          sourceRevision: "revision-old",
          events: [{ kind: "check-failed", sourceId: "check-old", detail: "Windows Smoke" }],
        },
      }),
      {
        ...monitorSnapshot("head-new", "revision-new"),
        checkRuns: [
          {
            id: "check-new",
            name: "Windows Smoke",
            status: "pending",
            headSha: "head-new",
            url: null,
            description: null,
          },
        ],
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("filters resolved findings and refreshes the prompt before dispatch", async () => {
    const commands = await runReactor(
      queuedReadModel({
        message: {
          messageId: MessageId.make("message-startup"),
          role: "user",
          text: "stale behind-base and review prompt",
          attachments: [],
        },
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          deliveryId: "delivery-1",
          availableTools: ["pr_monitor_context"],
          events: [
            { kind: "behind-base" },
            {
              kind: "new-review-comment",
              sourceId: "thread-live",
              detail: "please fix",
            },
          ],
        },
      }),
      {
        ...monitorSnapshot("head-current", "revision-new"),
        reviewThreads: [
          {
            id: "thread-live",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: now,
            updatedAt: now,
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.update",
      threadId,
      queuedTurnId,
      origin: {
        kind: "pull-request-monitor",
        headSha: "head-current",
        sourceRevision: "revision-new",
        events: [{ kind: "new-review-comment", sourceId: "thread-live" }],
      },
    });
    expect(commands[0]?.type === "thread.queued-turn.update" ? commands[0].text : "").toContain(
      "Comment from reviewer",
    );
    expect(commands[0]?.type === "thread.queued-turn.update" ? commands[0].text : "").not.toContain(
      "PR is behind",
    );
    expect(commands[1]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
  });

  it("backs off a failed monitor revalidation without dispatching", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.update",
      origin: {
        kind: "pull-request-monitor",
        revalidationAttemptCount: 1,
      },
    });
  });

  it("returns a monitor delivery to durable retry before deleting its queued turn", async () => {
    const retriedDeliveries: string[] = [];
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
          deliveryId: "delivery-1",
          revalidationAttemptCount: 2,
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
        onRetryQueuedDelivery: (deliveryId) => retriedDeliveries.push(deliveryId),
      },
    );

    expect(retriedDeliveries).toEqual(["delivery-1"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("keeps the queued turn when durable retry cannot be recorded", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
          deliveryId: "delivery-1",
          revalidationAttemptCount: 2,
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
        retryQueuedDeliveryError: new PullRequestMonitorError({
          message: "delivery store unavailable",
        }),
      },
    );

    expect(commands).toEqual([]);
  });
});
