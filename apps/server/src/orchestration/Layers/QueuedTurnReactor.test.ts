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
  type PullRequestMonitorSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
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

function pullRequestLayer(snapshot: PullRequestMonitorSnapshot) {
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
      monitorSnapshot: () => Effect.succeed(snapshot),
    }),
  );
}

async function runReactor(
  readModelInput: OrchestrationReadModel,
  snapshot: PullRequestMonitorSnapshot,
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
        }
        return { sequence: 2 };
      }),
    withWorktreeLock: (effect) => effect,
    streamDomainEvents: Stream.never,
  });
  const layer = QueuedTurnReactorLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(pullRequestLayer(snapshot)),
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

  it("dispatches feedback that remains actionable after provider state changes", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [
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

    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
  });
});
