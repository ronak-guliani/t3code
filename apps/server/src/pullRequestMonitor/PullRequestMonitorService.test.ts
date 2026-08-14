import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type PullRequestMonitorSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import MigrationMonitors from "../persistence/Migrations/071_PullRequestMonitors.ts";
import MigrationFeedback from "../persistence/Migrations/072_PullRequestMonitorFeedback.ts";
import MigrationOwnership from "../persistence/Migrations/073_PullRequestMonitorOwnership.ts";
import MigrationFallback from "../persistence/Migrations/074_PullRequestMonitorFallback.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  layer as pullRequestMonitorFeedbackServiceLayer,
  PullRequestMonitorFeedbackService,
} from "./PullRequestMonitorFeedbackService.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import {
  layer as pullRequestMonitorServiceLayer,
  PullRequestMonitorService,
} from "./PullRequestMonitorService.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";

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
    sourceRevision: "rev-1",
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
  };
}

const fakePullRequests = PullRequestService.PullRequestService.of({
  list: () => Effect.die("unused"),
  listStats: () => Effect.die("unused"),
  detail: (input) =>
    Effect.succeed({
      provider: "github" as const,
      capabilities: {
        diff: true,
        comment: true,
        actions: ["merge", "ready", "draft", "close", "reopen"] as const,
        mergeMethods: ["merge", "squash", "rebase"] as const,
        search: true,
        review: {
          inlineComment: true,
          reply: true,
          resolve: true,
          verdicts: ["comment", "approve", "request-changes"] as const,
        },
        reviewers: { request: true, listCandidates: true },
      },
      viewerPermissions: {
        actions: ["merge", "ready", "draft", "close", "reopen"] as const,
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"] as const,
        requestReviewers: true,
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

const knownThreads = new Map<
  string,
  {
    projectId: typeof projectId;
    worktreePath: string | null;
    archivedAt: string | null;
  }
>();

function seedThread(threadId: ThreadId, worktreePath: string | null = "/tmp/wt") {
  knownThreads.set(threadId, {
    projectId,
    worktreePath,
    archivedAt: null,
  });
}

const abandonedThreadIds: ThreadId[] = [];
const dispatchedCommands: Array<{ type: string; threadId?: ThreadId }> = [];
const launchedFallbackIds: ThreadId[] = [];
const preparedPrReferences: string[] = [];
let preparePrWorktreePath: string | null = "/tmp/pr-head";
let launchWorktreePath: string | null = "/tmp/fallback";

const fakeProjections = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.sync(() => {
      const row = knownThreads.get(threadId);
      if (!row) return Option.none();
      return Option.some({
        id: threadId,
        projectId: row.projectId,
        worktreePath: row.worktreePath,
        archivedAt: row.archivedAt,
      } as never);
    }),
  getProjectShellById: (id: typeof projectId) =>
    Effect.succeed(
      id === projectId
        ? Option.some({
            id: projectId,
            title: "App",
            workspaceRoot: "/tmp/app",
          } as never)
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"];

const fakeEngine = {
  dispatch: (command: {
    type: string;
    threadId?: ThreadId;
    worktreePath?: string | null;
    bootstrap?: unknown;
  }) =>
    Effect.sync(() => {
      const entry: { type: string; threadId?: ThreadId } = { type: command.type };
      if (command.threadId !== undefined) entry.threadId = command.threadId;
      dispatchedCommands.push(entry);
      if (command.type === "thread.archive" && command.threadId) {
        abandonedThreadIds.push(command.threadId);
      }
      // Fallback creates the thread first, claims ownership, then starts a turn.
      if (command.type === "thread.create" && command.threadId) {
        const path =
          launchWorktreePath === null
            ? null
            : (command.worktreePath ?? `${launchWorktreePath}-${command.threadId}`);
        launchedFallbackIds.push(command.threadId);
        seedThread(command.threadId, path);
      }
      return { sequence: 1 };
    }),
} as unknown as OrchestrationEngineService["Service"];

const fakeGit = {
  preparePullRequestThread: (input: { reference: string }) =>
    Effect.gen(function* () {
      preparedPrReferences.push(input.reference);
      if (preparePrWorktreePath === null) {
        return yield* Effect.fail(new Error("PR head missing") as never);
      }
      return {
        pullRequest: {
          number: Number(String(input.reference).replace("#", "")),
          title: "Monitor me",
          url: "https://github.com/acme/app/pull/42",
          baseBranch: "main",
          headBranch: "feat/monitor",
          state: "open" as const,
        },
        branch: "feat/monitor",
        worktreePath: preparePrWorktreePath,
      } as never;
    }),
} as unknown as GitManager["Service"];

const fakeSettings = {
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    autoMonitorPullRequestsOnCreate: true,
    autoLaunchPrMonitorFallback: true,
    textGenerationModelSelection: {
      instanceId: "openai",
      model: "gpt-test",
    } as ModelSelection,
  }),
  updateSettings: () => Effect.die("unused"),
  streamChanges: Stream.empty,
} as unknown as ServerSettingsService["Service"];

const MigratedSql = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
    yield* MigrationMonitors;
    yield* MigrationFeedback;
    yield* MigrationOwnership;
    yield* MigrationFallback;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const FeedbackLayer = pullRequestMonitorFeedbackServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
);

// provideMerge engine/projections so method bodies that yield* them at call
// time still resolve (Layer.provide alone only satisfies construction R).
const TestLayer = pullRequestMonitorServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
  Layer.provideMerge(FeedbackLayer),
  Layer.provide(Layer.succeed(GitManager, fakeGit)),
  Layer.provide(Layer.succeed(ServerSettingsService, fakeSettings)),
  Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, fakeProjections)),
  Layer.provideMerge(Layer.succeed(OrchestrationEngineService, fakeEngine)),
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

  it.effect("transfers ownership to a single owner thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const ownerA = ThreadId.make("thr_owner_a");
      const ownerB = ThreadId.make("thr_owner_b");
      seedThread(ownerA);
      seedThread(ownerB);
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
      const sql = yield* SqlClient.SqlClient;
      const owner = ThreadId.make("thr_owner_main");
      const review = ThreadId.make("thr_review_1");
      seedThread(owner);
      seedThread(review);
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

      const events = yield* sql<{
        readonly from_thread_id: string | null;
        readonly to_thread_id: string | null;
      }>`
        SELECT from_thread_id, to_thread_id
        FROM pull_request_monitor_ownership_events
        WHERE monitor_id = ${result.monitor.id}
      `;
      assert.deepEqual(events, [{ from_thread_id: null, to_thread_id: owner }]);
    }),
  );

  it.effect("submitFindings audits an owner handoff after starting an existing monitor", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const ownerA = ThreadId.make("thr_owner_audit_a");
      const ownerB = ThreadId.make("thr_owner_audit_b");
      const review = ThreadId.make("thr_review_audit");
      seedThread(ownerA);
      seedThread(ownerB);
      seedThread(review);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 45,
        ownerThreadId: ownerA,
      });

      const result = yield* service.submitFindings({
        reference: {
          projectId,
          repository: "acme/app",
          number: 45,
        },
        reviewThreadId: review,
        ownerThreadId: ownerB,
      });
      assert.strictEqual(result.monitor.ownerThreadId, ownerB);

      const events = yield* sql<{
        readonly from_thread_id: string | null;
        readonly to_thread_id: string | null;
      }>`
        SELECT from_thread_id, to_thread_id
        FROM pull_request_monitor_ownership_events
        WHERE monitor_id = ${started.monitor.id}
        ORDER BY created_at
      `;
      assert.deepEqual(events, [{ from_thread_id: ownerA, to_thread_id: ownerB }]);
    }),
  );

  it.effect("rejects ownership transfer to a missing project thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_owner_valid");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 46,
        ownerThreadId: owner,
      });

      const result = yield* Effect.result(
        service.transferOwnership({
          monitorId: started.monitor.id,
          toThreadId: ThreadId.make("thr_owner_missing"),
        }),
      );
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("launchFallback creates exclusive owner via prepared worktree thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 47,
      });
      assert.isNull(started.monitor.ownerThreadId);

      const before = launchedFallbackIds.length;
      const refsBefore = preparedPrReferences.length;
      const fallback = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isTrue(fallback.launched);
      assert.isNotNull(fallback.fallbackThreadId);
      assert.strictEqual(fallback.monitor.ownerThreadId, fallback.fallbackThreadId);
      assert.isNull(fallback.previousOwnerThreadId);
      assert.strictEqual(preparedPrReferences[refsBefore], "#47");
      assert.isTrue(launchedFallbackIds.length > before);

      // Second launch within cooldown should not dual-own while owner remains available.
      const again = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isFalse(again.launched);
      assert.strictEqual(again.skippedReason, "recent-fallback-cooldown");
      assert.strictEqual(again.fallbackThreadId, fallback.fallbackThreadId);
    }),
  );

  it.effect("launchFallback relaunches when cooldown owner is deleted", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 51,
      });
      const first = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isTrue(first.launched);
      // Simulate dead fallback owner while still recorded on the monitor.
      knownThreads.delete(first.fallbackThreadId);

      const second = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-unavailable",
      });
      assert.isTrue(second.launched);
      assert.notStrictEqual(second.fallbackThreadId, first.fallbackThreadId);
      assert.strictEqual(second.previousOwnerThreadId, first.fallbackThreadId);
    }),
  );

  it.effect("launchFallback refuses available owner without force", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_owner_live");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 48,
        ownerThreadId: owner,
      });

      const refused = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "explicit",
        }),
      );
      assert.strictEqual(refused._tag, "Failure");

      const forced = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "explicit",
        force: true,
      });
      assert.isTrue(forced.launched);
      assert.strictEqual(forced.previousOwnerThreadId, owner);
      assert.notStrictEqual(forced.fallbackThreadId, owner);
    }),
  );

  it.effect("launchFallback does not transfer ownership when prep fails", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 49,
      });
      preparePrWorktreePath = null;
      const result = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "owner-missing",
        }),
      );
      preparePrWorktreePath = "/tmp/pr-head";
      assert.strictEqual(result._tag, "Failure");
      const status = yield* service.status({ monitorId: started.monitor.id });
      assert.isNull(status.monitor?.ownerThreadId ?? null);
    }),
  );

  it.effect("launchFallback serializes concurrent attempts with a lease", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const monitorStore = yield* PullRequestMonitorStore.make;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 52,
      });
      // Hold the fallback lease so a concurrent launch cannot dual-start agents.
      const now = "2026-08-11T00:00:00.000Z";
      const held = yield* monitorStore.tryAcquireLease({
        canonicalKey: `fallback:${started.monitor.canonicalKey}`,
        ownerId: "holder",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isTrue(held);

      const blocked = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "owner-missing",
        }),
      );
      assert.strictEqual(blocked._tag, "Failure");
      yield* monitorStore.releaseLease(`fallback:${started.monitor.canonicalKey}`, "holder");
    }),
  );

  it.effect("feedback state append/remove keep circuit fields atomic", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 50,
      });
      const now = "2026-08-11T00:00:00.000Z";

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
        deliveryFailureCount: 2,
        circuitOpenUntil: "2026-08-11T00:05:00.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.removePendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-a"],
        updatedAt: now,
      });

      const state = yield* feedbackStore.getState(started.monitor.id);
      assert.deepStrictEqual(state.pendingRevisionIds, ["revision-b"]);
      assert.strictEqual(state.deliveryFailureCount, 2);
      assert.strictEqual(state.circuitOpenUntil, "2026-08-11T00:05:00.000Z");
    }),
  );

  it.effect("reopens resolved feedback with cleared disposition fields", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const owner = ThreadId.make("thr_feedback_owner");
      seedThread(owner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 46,
        ownerThreadId: owner,
      });

      const event = {
        kind: "check-failed" as const,
        sourceId: "check-ci",
        detail: "ci failed",
        edited: false,
      };
      const snapshot = sampleSnapshot();
      const readiness = {
        ready: false as const,
        label: "blocked" as const,
        blockers: [{ kind: "check-failed" as const, detail: "ci failed" }],
      };

      yield* feedback.ingestSnapshot({
        monitor: started.monitor,
        snapshot,
        readiness,
        events: [event],
      });
      const afterIngest = yield* feedback.context({
        monitorId: started.monitor.id,
        includeClosed: true,
        resolveMonitor: () => Effect.succeed(started.monitor),
      });
      assert.strictEqual(afterIngest.items.length, 1);
      const item = afterIngest.items[0]!;
      assert.strictEqual(item.status, "open");
      assert.isNull(item.disposition);

      yield* feedback.report({
        monitorId: started.monitor.id,
        itemId: item.id,
        disposition: "resolved",
        note: "fixed",
        reporterThreadId: owner,
        resolveMonitor: () => Effect.succeed(started.monitor),
        requestRecheck: () => Effect.void,
      });
      const afterResolve = yield* feedback.context({
        monitorId: started.monitor.id,
        includeClosed: true,
        resolveMonitor: () => Effect.succeed(started.monitor),
      });
      const resolved = afterResolve.items.find((row) => row.id === item.id);
      assert.isDefined(resolved);
      assert.strictEqual(resolved!.status, "closed");
      assert.strictEqual(resolved!.disposition, "resolved");

      yield* feedback.ingestSnapshot({
        monitor: started.monitor,
        snapshot,
        readiness,
        events: [event],
      });
      const afterReopen = yield* feedback.context({
        monitorId: started.monitor.id,
        includeClosed: true,
        resolveMonitor: () => Effect.succeed(started.monitor),
      });
      const reopened = afterReopen.items.find((row) => row.id === item.id);
      assert.isDefined(reopened);
      assert.strictEqual(reopened!.status, "open");
      assert.isNull(reopened!.disposition);
      assert.isNull(reopened!.dispositionNote);
      assert.isNull(reopened!.dispositionAt);
      assert.isNull(reopened!.dispositionByThreadId);
    }),
  );
});
