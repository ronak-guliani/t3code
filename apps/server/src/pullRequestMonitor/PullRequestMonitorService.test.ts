import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type PullRequestMonitorSnapshot,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import Migration0050 from "../persistence/Migrations/050_PullRequestMonitors.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
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

const MigratedSql = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
    yield* Migration0050;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const TestLayer = pullRequestMonitorServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
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
      assert.strictEqual(status.latestSnapshot?.headSha, "deadbeef");

      const stopped = yield* service.stop({ monitorId: started.monitor.id });
      assert.strictEqual(stopped.monitor.enabled, false);
      assert.strictEqual(stopped.monitor.status, "stopped");
    }),
  );
});
