import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type PullRequestMonitorFeedbackItemId,
  type PullRequestMonitorSnapshot,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import Migration0050 from "../persistence/Migrations/050_PullRequestMonitors.ts";
import Migration0051 from "../persistence/Migrations/051_PullRequestMonitorFeedback.ts";
import Migration0052 from "../persistence/Migrations/052_PullRequestMonitorOwnership.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import { layer as pullRequestMonitorFeedbackServiceLayer } from "./PullRequestMonitorFeedbackService.ts";
import {
  layer as pullRequestMonitorServiceLayer,
  PullRequestMonitorService,
} from "./PullRequestMonitorService.ts";

const projectId = ProjectId.make("proj_monitor_1");

function sampleSnapshot(): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    state: "open",
    isDraft: false,
    headSha: "deadbeef",
    baseBranch: "main",
    headBranch: "feat/monitor",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Monitor me",
    url: "https://github.com/acme/app/pull/42",
    fetchedAt: "2026-08-11T00:00:00.000Z",
    sourceRevision: "rev-a",
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: false,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [
      {
        id: "1",
        name: "ci",
        status: "success",
        headSha: "deadbeef",
        url: null,
        description: null,
      },
    ],
  };
}

const fakePullRequests = PullRequestService.PullRequestService.of({
  list: () => Effect.die("unused"),
  listStats: () => Effect.die("unused"),
  detail: (input: PullRequestRef) =>
    Effect.succeed({
      provider: "github" as const,
      capabilities: {
        diff: true,
        comment: true,
        actions: [],
        mergeMethods: [],
        search: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
      },
      viewerPermissions: {
        actions: [],
        comment: true,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
      projectId: input.projectId,
      projectTitle: "App",
      workspaceRoot: "/tmp/app",
      repository: input.repository,
      number: input.number,
      title: "Monitor me",
      body: "",
      url: `https://github.com/${input.repository}/pull/${input.number}`,
      author: null,
      state: "open" as const,
      isDraft: false,
      mergeability: "mergeable" as const,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      headBranch: "feat/monitor",
      baseBranch: "main",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
    }),
  activity: () => Effect.die("unused"),
  diff: () => Effect.die("unused"),
  diffFileContents: () => Effect.die("unused"),
  runAction: () => Effect.die("unused"),
  comment: () => Effect.die("unused"),
  submitReview: () => Effect.die("unused"),
  replyToThread: () => Effect.die("unused"),
  setThreadResolution: () => Effect.die("unused"),
  reviewerCandidates: () => Effect.die("unused"),
  requestReviewers: () => Effect.die("unused"),
  invalidate: () => Effect.void,
  monitorSnapshot: () => Effect.succeed(sampleSnapshot()),
});

const fakeThreads = ThreadManagement.ThreadManagementService.of({
  ensureLegacyTranscript: () => Effect.void,
  dispatch: () => Effect.die("unused"),
  getThreadProjection: () => Effect.die("unused"),
  getThreadSnapshot: () => Effect.die("unused"),
  getProjectThread: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getThreadShell: () => Effect.die("unused"),
  listProjectThreads: () => Effect.succeed([]),
  sendToThread: () => Effect.die("unused"),
  waitForThread: () => Effect.die("unused"),
  interruptThread: () => Effect.die("unused"),
  getThreadEventSequence: () => Effect.die("unused"),
  streamStoredEvents: Stream.die("unused"),
  streamStoredEventsFrom: () => Stream.die("unused"),
  streamDomainEvents: Stream.die("unused"),
});

const MigratedSql = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
    yield* Migration0050;
    yield* Migration0051;
    yield* Migration0052;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const FeedbackLayer = pullRequestMonitorFeedbackServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
  Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, fakeThreads)),
);

const TestLayer = pullRequestMonitorServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
  Layer.provide(FeedbackLayer),
  Layer.provideMerge(MigratedSql),
  Layer.provideMerge(NodeCrypto.layer),
);

const layer = it.layer(TestLayer);

layer("PullRequestMonitorService", (it) => {
  it.effect("starts one canonical monitor and exposes status", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
      });
      assert.strictEqual(started.monitor.enabled, true);
      assert.strictEqual(started.monitor.repository, "acme/app");
      assert.strictEqual(started.monitor.number, 42);
      assert.isTrue(started.monitor.status === "monitoring" || started.monitor.status === "ready");

      const again = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
      });
      assert.strictEqual(again.monitor.id, started.monitor.id);

      const status = yield* service.status({ monitorId: started.monitor.id });
      assert.isNotNull(status.monitor);
      assert.isNotNull(status.latestSnapshot);
      assert.isArray(status.openFeedback);
      assert.isArray(status.recentDeliveries);
      assert.isArray(status.recentReports);

      const stopped = yield* service.stop({ monitorId: started.monitor.id });
      assert.strictEqual(stopped.monitor.enabled, false);
      assert.strictEqual(stopped.monitor.status, "stopped");
    }),
  );

  it.effect("clears reopened dispositions and preserves concurrent pending revisions", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 43,
      });
      const now = "2026-08-11T00:00:00.000Z";
      const itemId = "fb_item_reopened" as PullRequestMonitorFeedbackItemId;
      const item = {
        id: itemId,
        monitorId: started.monitor.id,
        stableKey: "review:reopened",
        kind: "review" as const,
        status: "open" as const,
        disposition: null,
        dispositionNote: null,
        dispositionAt: null,
        dispositionByThreadId: null,
        firstSeenAt: now,
        lastSeenAt: now,
        currentRevisionId: null,
        summary: "Reopened finding",
      };

      yield* feedbackStore.upsertOpenItem({ item });
      yield* feedbackStore.setDisposition({
        itemId,
        disposition: "resolved",
        note: "Fixed",
        at: now,
        byThreadId: null,
        status: "closed",
      });
      yield* feedbackStore.upsertOpenItem({ item });

      const reopened = yield* feedbackStore.getItem(itemId);
      assert.isNotNull(reopened);
      assert.strictEqual(reopened.status, "open");
      assert.isNull(reopened.disposition);
      assert.isNull(reopened.dispositionNote);

      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-a"],
        debounceUntil: "2026-08-11T00:00:15.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-b"],
        debounceUntil: "2026-08-11T00:00:30.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.setDeliveryCircuitState({
        monitorId: started.monitor.id,
        deliveryFailureCount: 1,
        circuitOpenUntil: null,
        updatedAt: now,
      });
      yield* feedbackStore.removePendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-a"],
        updatedAt: now,
      });

      const state = yield* feedbackStore.getState(started.monitor.id);
      assert.deepStrictEqual(state.pendingRevisionIds, ["revision-b"]);
      assert.strictEqual(state.deliveryFailureCount, 1);
    }),
  );

  it.effect("transfers ownership to a single owner thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const ownerA = ThreadId.make("thr_owner_a");
      const ownerB = ThreadId.make("thr_owner_b");
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 43,
        ownerThreadId: ownerA,
      });
      assert.strictEqual(started.monitor.ownerThreadId, ownerA);

      const transferred = yield* service.transferOwnership({
        monitorId: started.monitor.id,
        toThreadId: ownerB,
        reason: "fallback",
      });
      assert.strictEqual(transferred.monitor.ownerThreadId, ownerB);
      assert.isNull(transferred.monitor.linkedReviewThreadId);
    }),
  );

  it.effect("submitFindings links review thread without dual owners", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_owner_main");
      const review = ThreadId.make("thr_review_1");
      const result = yield* service.submitFindings({
        reference: {
          projectId,
          repository: "acme/app",
          number: 44,
        },
        reviewThreadId: review,
        ownerThreadId: owner,
        summary: "Three findings handed off",
        startMonitoring: true,
      });
      assert.strictEqual(result.monitoringStarted, true);
      assert.strictEqual(result.ownerThreadId, owner);
      assert.strictEqual(result.linkedReviewThreadId, review);
      assert.strictEqual(result.monitor.ownerThreadId, owner);
      assert.strictEqual(result.monitor.linkedReviewThreadId, review);
      assert.notStrictEqual(result.monitor.ownerThreadId, result.monitor.linkedReviewThreadId);
    }),
  );
});
