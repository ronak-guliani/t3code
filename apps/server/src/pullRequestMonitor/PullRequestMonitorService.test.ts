import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  PullRequestMonitorError,
  PullRequestOperationError,
  ThreadId,
  type ModelSelection,
  type PullRequestMonitorSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import MigrationMonitors from "../persistence/Migrations/071_PullRequestMonitors.ts";
import MigrationFeedback from "../persistence/Migrations/072_PullRequestMonitorFeedback.ts";
import MigrationOwnership from "../persistence/Migrations/073_PullRequestMonitorOwnership.ts";
import MigrationFallback from "../persistence/Migrations/074_PullRequestMonitorFallback.ts";
import MigrationRevisionIdentity from "../persistence/Migrations/076_PullRequestMonitorRevisionIdentity.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  layer as pullRequestMonitorFeedbackServiceLayer,
  PullRequestMonitorFeedbackService,
} from "./PullRequestMonitorFeedbackService.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import {
  associatedOwnerCandidates,
  layer as pullRequestMonitorServiceLayer,
  PullRequestMonitorService,
} from "./PullRequestMonitorService.ts";
import { emptyCursor } from "./monitorDiff.ts";
import { LEASE_TTL_MS } from "./pollSchedule.ts";
import { emptyFeedbackReadiness } from "./readiness.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";

const projectId = ProjectId.make("proj_monitor_1");

/** Same clock the monitor writes with, so lease fixtures line up with commit time. */
const isoNow = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

function sampleSnapshot(
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot {
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
      baseComparisonKnown: true,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
    ...overrides,
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
  monitorSnapshot: () =>
    Effect.gen(function* () {
      const snapshot = currentSnapshot;
      // Runs while the poll attempt is in flight: the seam where a slow provider read
      // can outlive the attempt's lease.
      yield* monitorSnapshotHook;
      return snapshot;
    }),
});

/** Fresh provider state the monitor re-reads before every delivery. */
let currentSnapshot: PullRequestMonitorSnapshot = sampleSnapshot();
/** Injected mid-read behaviour; tests reset it to `Effect.void` after one use. */
let monitorSnapshotHook: Effect.Effect<void, PullRequestOperationError> = Effect.void;

const knownThreads = new Map<
  string,
  {
    projectId: typeof projectId;
    worktreePath: string | null;
    archivedAt: string | null;
    busy: boolean;
  }
>();

function seedThread(threadId: ThreadId, worktreePath: string | null = "/tmp/wt") {
  knownThreads.set(threadId, {
    projectId,
    worktreePath,
    archivedAt: null,
    busy: false,
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
        modelSelection: { instanceId: "copilot", model: "gpt-test" },
        latestTurn: row.busy ? { state: "running" } : null,
        session: row.busy ? { status: "running", activeTurnId: "turn-1" } : null,
        hasPendingQueuedTurn: false,
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
  getReadModel: () =>
    Effect.succeed({
      threads: [...knownThreads.entries()].map(([id, thread]) => ({
        id,
        projectId: thread.projectId,
        title: `Chat ${id}`,
        pullRequest: null,
        archivedAt: thread.archivedAt,
        deletedAt: null,
      })),
    } as never),
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
      if (command.type === "thread.turn.interrupt" && command.threadId) {
        const row = knownThreads.get(command.threadId);
        if (row) knownThreads.set(command.threadId, { ...row, busy: false });
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
    yield* MigrationRevisionIdentity;
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

it("returns only active chats associated with the monitored pull request", () => {
  const candidates = associatedOwnerCandidates(
    [
      {
        id: ThreadId.make("owner"),
        projectId,
        title: "Fix PR",
        pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: ThreadId.make("other-pr"),
        projectId,
        title: "Other PR",
        pullRequest: { number: 43, url: "https://github.com/acme/app/pull/43" },
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: ThreadId.make("archived"),
        projectId,
        title: "Archived",
        pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
        archivedAt: "2026-08-17T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    { projectId, repository: "acme/app", number: 42 },
  );

  assert.deepStrictEqual(candidates, [{ threadId: ThreadId.make("owner"), title: "Fix PR" }]);
});

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
      assert.deepStrictEqual(status.ownerCandidates, []);
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

  it.effect("can explicitly resume a monitor in observe-only mode", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("owner-observe");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
        ownerThreadId: owner,
      });
      yield* service.stop({ monitorId: started.monitor.id });

      const resumed = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
        ownerMode: "observe-only",
      });

      assert.isNull(resumed.monitor.ownerThreadId);
      assert.strictEqual(resumed.monitor.enabled, true);
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
      assert.isNotNull(held);

      const blocked = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "owner-missing",
        }),
      );
      assert.strictEqual(blocked._tag, "Failure");
      yield* monitorStore.releaseLease(held!);
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

  it.effect("parks a resolved claim until fresh provider state confirms it", () =>
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
      const failing = sampleSnapshot({
        checkRuns: [
          {
            id: "check-ci",
            name: "ci",
            status: "failure",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: failing,
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

      // Agent prose alone must not close a finding.
      const reported = yield* feedback.report({
        monitorId: started.monitor.id,
        itemId: item.id,
        disposition: "resolved",
        note: "fixed",
        reporterThreadId: owner,
        resolveMonitor: () => Effect.succeed(started.monitor),
        requestRecheck: () => Effect.void,
      });
      assert.isTrue(reported.awaitingVerification);
      assert.strictEqual(reported.item.status, "verifying");

      // Still failing upstream: the claim is rejected and the finding reopens.
      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: failing,
        events: [],
      });
      const stillOpen = yield* feedback
        .context({
          monitorId: started.monitor.id,
          includeClosed: true,
          resolveMonitor: () => Effect.succeed(started.monitor),
        })
        .pipe(Effect.map((result) => result.items.find((row) => row.id === item.id)));
      assert.strictEqual(stillOpen?.status, "open");

      // Provider now reports success: the finding closes on provider evidence.
      const passing = sampleSnapshot({
        checkRuns: [
          {
            id: "check-ci",
            name: "ci",
            status: "success",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });
      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: passing,
        events: [],
      });
      const closed = yield* feedback
        .context({
          monitorId: started.monitor.id,
          includeClosed: true,
          resolveMonitor: () => Effect.succeed(started.monitor),
        })
        .pipe(Effect.map((result) => result.items.find((row) => row.id === item.id)));
      assert.strictEqual(closed?.status, "closed");
      assert.strictEqual(closed?.disposition, "resolved-upstream");
    }),
  );

  it.effect("ingests the same observation twice without queueing it twice", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_replay_owner");
      seedThread(owner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 61,
        ownerThreadId: owner,
      });
      const snapshot = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-replay",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      const event = {
        kind: "new-review-comment" as const,
        sourceId: "thread-replay",
        detail: "please fix",
      };

      yield* feedback.reconcileAndIngest({ monitor: started.monitor, snapshot, events: [event] });
      const first = yield* feedbackStore.getState(started.monitor.id);
      assert.strictEqual(first.pendingRevisionIds.length, 1);

      // Replaying the identical observation is a no-op: identity is source content.
      yield* feedback.reconcileAndIngest({ monitor: started.monitor, snapshot, events: [event] });
      const second = yield* feedbackStore.getState(started.monitor.id);
      assert.deepStrictEqual(second.pendingRevisionIds, first.pendingRevisionIds);

      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items.length, 1);
      const revisions = yield* feedbackStore.listRevisionsByIds(first.pendingRevisionIds);
      assert.strictEqual(revisions.length, 1);
    }),
  );

  it.effect("rejects an unexpired lease and fences superseded poll commits", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 62,
      });
      const now = "2026-08-11T00:00:00.000Z";
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-1",
        nowIso: now,
        expiresAt: "2026-08-11T00:01:30.000Z",
      });
      assert.isNotNull(lease);

      // A second attempt cannot claim the same monitor while the lease is live,
      // even from the same process.
      const blocked = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-2",
        nowIso: now,
        expiresAt: "2026-08-11T00:01:30.000Z",
      });
      assert.isNull(blocked);

      // After expiry the next attempt wins with a higher generation.
      const afterExpiry = "2026-08-11T00:02:00.000Z";
      const next = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-3",
        nowIso: afterExpiry,
        expiresAt: "2026-08-11T00:03:30.000Z",
      });
      assert.isNotNull(next);
      assert.isTrue(next!.generation > lease!.generation);
      assert.isFalse(yield* store.holdsLease(lease!, afterExpiry));

      // The superseded generation cannot commit: its write is fenced out.
      const stale = yield* store.commitPollObservation({
        lease: lease!,
        cursor: emptyCursor(),
        snapshotId: "snap-stale",
        snapshot: sampleSnapshot(),
        events: [],
        ingest: Effect.succeed({
          openCount: 0,
          verifyingCount: 0,
          needsHumanCount: 0,
          pendingDeliveryCount: 0,
        }),
        finalize: () => ({
          record: { ...started.monitor, lastError: "stale write" },
          readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
        }),
      });
      assert.isFalse(stale.committed);
      const unchanged = yield* store.getById(started.monitor.id);
      assert.isNull(unchanged?.lastError ?? null);

      // Releasing is fenced too: the stale generation cannot drop the live lease.
      yield* store.releaseLease(lease!);
      assert.isTrue(yield* store.holdsLease(next!, afterExpiry));
      yield* store.releaseLease(next!);
    }),
  );

  it.effect("fences a poll whose provider read outlived the attempt lease", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const sql = yield* SqlClient.SqlClient;

      currentSnapshot = sampleSnapshot({
        sourceRevision: "rev-fenced",
        reviewThreads: [
          {
            id: "thread-fenced",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      // The provider read itself outlives the TTL the attempt was granted.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        currentSnapshot = sampleSnapshot();
        // Park the scheduler so the only writers in this race are the two workers.
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
      });

      const started = yield* monitors.start({ projectId, repository: "acme/app", number: 69 });

      // An expired attempt commits nothing: no state, snapshot, cursor, or feedback.
      const record = yield* store.getById(started.monitor.id);
      assert.strictEqual(record?.status, "monitoring");
      assert.isNull(record?.lastPolledAt ?? null);
      assert.isNull(record?.readiness ?? null);
      assert.isNull(record?.lastError ?? null);
      const cursor = yield* store.getCursor(started.monitor.id);
      assert.notStrictEqual(cursor.sourceRevision, "rev-fenced");
      assert.isNull(yield* store.latestSnapshot(started.monitor.id));
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.deepStrictEqual(items, []);

      // The lease really was free: the worker that claims it next is the one that writes.
      const now = yield* isoNow;
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "worker-next",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(lease);
      const commit = yield* store.commitPollObservation({
        lease: lease!,
        cursor: { ...emptyCursor(), sourceRevision: "rev-worker-next" },
        snapshotId: "snap-worker-next",
        snapshot: sampleSnapshot({
          sourceRevision: "rev-worker-next",
          fetchedAt: "2026-08-12T00:00:00.000Z",
        }),
        events: [],
        ingest: Effect.succeed(emptyFeedbackReadiness),
        finalize: (_feedback, commitAt) => ({
          record: { ...started.monitor, lastPolledAt: commitAt, updatedAt: commitAt },
          readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
        }),
      });
      assert.isTrue(commit.committed);
      const latest = yield* store.latestSnapshot(started.monitor.id);
      assert.strictEqual(latest?.snapshot.sourceRevision, "rev-worker-next");
      yield* store.releaseLease(lease!);
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("a poll failing after its lease expired cannot clobber a newer poll", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const sql = yield* SqlClient.SqlClient;
      const reference = { projectId, repository: "acme/app", number: 70 } as const;

      currentSnapshot = sampleSnapshot({ sourceRevision: "rev-healthy" });
      const started = yield* monitors.start(reference);
      assert.isNull(started.monitor.lastError);

      // A crash after the lease expired, while a newer worker already committed.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
        const now = yield* isoNow;
        const newer = yield* store
          .tryAcquireLease({
            canonicalKey: started.monitor.canonicalKey,
            ownerId: "worker-newer",
            nowIso: now,
            expiresAt: addMs(now, LEASE_TTL_MS),
          })
          .pipe(Effect.orDie);
        assert.isNotNull(newer);
        const commit = yield* store
          .commitPollObservation({
            lease: newer!,
            cursor: { ...emptyCursor(), sourceRevision: "rev-newer" },
            snapshotId: "snap-newer",
            snapshot: sampleSnapshot({
              sourceRevision: "rev-newer",
              fetchedAt: "2026-08-12T00:00:00.000Z",
            }),
            events: [],
            ingest: Effect.succeed(emptyFeedbackReadiness),
            finalize: (_feedback, commitAt) => ({
              record: {
                ...started.monitor,
                status: "monitoring" as const,
                lastError: null,
                pollFailureCount: 0,
                lastPolledAt: commitAt,
                nextPollAt: "2099-01-01T00:00:00.000Z",
                updatedAt: commitAt,
              },
              readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
            }),
          })
          .pipe(Effect.orDie);
        assert.isTrue(commit.committed);
        yield* store.releaseLease(newer!).pipe(Effect.orDie);
        return yield* Effect.die(new Error("stale worker crashed"));
      });
      yield* monitors.start(reference);

      const afterDefect = yield* store.getById(started.monitor.id);
      assert.strictEqual(afterDefect?.status, "monitoring");
      assert.isNull(afterDefect?.lastError ?? null);
      assert.strictEqual(afterDefect?.pollFailureCount, 0);
      assert.strictEqual(
        (yield* store.latestSnapshot(started.monitor.id))?.snapshot.sourceRevision,
        "rev-newer",
      );

      // Typed provider failures are fenced by the same expiry, with no newer writer.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
        return yield* new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "host unreachable after a long read",
        });
      });
      yield* monitors.start(reference);

      const afterFailure = yield* store.getById(started.monitor.id);
      assert.notStrictEqual(afterFailure?.status, "error");
      assert.isNull(afterFailure?.lastError ?? null);
      assert.strictEqual(afterFailure?.pollFailureCount, 0);
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("a poll that cannot claim the lease leaves monitor state untouched", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const reference = { projectId, repository: "acme/app", number: 71 } as const;
      const started = yield* monitors.start(reference);
      const before = yield* store.getById(started.monitor.id);

      const now = yield* isoNow;
      const held = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "worker-holding",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(held);

      yield* monitors.start(reference);
      const after = yield* store.getById(started.monitor.id);
      assert.strictEqual(after?.lastPolledAt ?? null, before?.lastPolledAt ?? null);
      assert.isNull(after?.lastError ?? null);
      assert.strictEqual(after?.pollFailureCount, 0);
      yield* store.releaseLease(held!);
    }),
  );

  it.effect("rolls the cursor back when ingestion fails mid-poll", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 63,
      });
      const before = yield* store.getCursor(started.monitor.id);
      const now = "2026-08-11T00:00:00.000Z";
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-ingest",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(lease);

      const failed = yield* Effect.result(
        store.commitPollObservation({
          lease: lease!,
          cursor: { ...emptyCursor(), sourceRevision: "rev-next", headSha: "next-head" },
          snapshotId: "snap-atomic",
          snapshot: sampleSnapshot(),
          events: [],
          ingest: Effect.fail(
            new PullRequestMonitorError({ message: "ingest exploded" }),
          ) as Effect.Effect<never, PullRequestMonitorError>,
          finalize: () => ({
            record: started.monitor,
            readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
          }),
        }),
      );
      assert.strictEqual(failed._tag, "Failure");

      const after = yield* store.getCursor(started.monitor.id);
      assert.strictEqual(after.sourceRevision, before.sourceRevision);
      const snapshotRow = yield* store.latestSnapshot(started.monitor.id);
      assert.notStrictEqual(snapshotRow?.snapshot.sourceRevision, "rev-next");
      yield* store.releaseLease(lease!);
    }),
  );

  it.effect("submits structured findings as individually addressable feedback", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_findings_owner");
      const reviewer = ThreadId.make("thr_findings_review");
      seedThread(owner);
      seedThread(reviewer);
      yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 64,
        ownerThreadId: owner,
      });

      const submitted = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number: 64 },
        reviewThreadId: reviewer,
        ownerThreadId: owner,
        summary: "two findings",
        findings: [
          {
            key: "finding-a",
            title: "Unbounded query",
            detail: "Add a limit.",
            severity: "major",
            path: "src/a.ts",
            line: 12,
          },
          {
            title: "Typo",
            detail: "Fix the message.",
            severity: "nit",
          },
        ],
      });

      assert.strictEqual(submitted.linkedReviewThreadId, reviewer);
      assert.strictEqual(submitted.ownerThreadId, owner);
      assert.strictEqual(submitted.findings.length, 2);
      assert.isTrue(submitted.findings.every((finding) => finding.created));
      assert.strictEqual(new Set(submitted.findings.map((f) => f.itemId)).size, 2);
      assert.strictEqual(new Set(submitted.findings.map((f) => f.revisionId)).size, 2);

      const context = yield* monitors.context({
        monitorId: submitted.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(context.items.filter((item) => item.kind === "review-finding").length, 2);

      // Re-submitting the same findings is idempotent per source revision.
      const again = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number: 64 },
        reviewThreadId: reviewer,
        findings: [
          {
            key: "finding-a",
            title: "Unbounded query",
            detail: "Add a limit.",
            severity: "major",
            path: "src/a.ts",
            line: 12,
          },
        ],
      });
      assert.isFalse(again.findings[0]!.created);
    }),
  );

  it.effect("queues remediation behind a user's active turn instead of steering it", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_delivery_owner");
      seedThread(owner);
      // The owner is mid-turn while the finding arrives.
      knownThreads.set(owner, {
        projectId,
        worktreePath: "/tmp/wt",
        archivedAt: null,
        busy: true,
      });

      const live = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-live",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      currentSnapshot = live;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 67,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: live,
        events: [{ kind: "new-review-comment", sourceId: "thread-live", detail: "please fix" }],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      assert.strictEqual(state.pendingRevisionIds.length, 1);
      // Mature the debounce window without waiting on the clock.
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "delivered");
      assert.isTrue(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("suppresses a wake when the provider resolved the finding first", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_stale_owner");
      seedThread(owner);

      const withThread = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-stale",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      currentSnapshot = withThread;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 68,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: withThread,
        events: [{ kind: "new-review-comment", sourceId: "thread-stale", detail: "please fix" }],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      // The reviewer resolves the thread before the batch matures.
      currentSnapshot = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-stale",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: true,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "suppressed");
      assert.isFalse(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items[0]?.status, "closed");
      assert.strictEqual(items[0]?.disposition, "resolved-upstream");
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("interrupts a busy previous owner before handing ownership to a fallback", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const previousOwner = ThreadId.make("thr_busy_owner");
      seedThread(previousOwner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 65,
        ownerThreadId: previousOwner,
      });

      // The owner is gone from the shell but its turn is still running.
      knownThreads.set(previousOwner, {
        projectId,
        worktreePath: "/tmp/wt",
        archivedAt: "2026-08-11T00:00:00.000Z",
        busy: true,
      });
      dispatchedCommands.length = 0;

      const result = yield* monitors.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-unavailable",
      });
      assert.isTrue(result.launched);
      assert.strictEqual(result.previousOwnerThreadId, previousOwner);

      const interruptIndex = dispatchedCommands.findIndex(
        (command) => command.type === "thread.turn.interrupt",
      );
      const createIndex = dispatchedCommands.findIndex(
        (command) => command.type === "thread.create",
      );
      assert.isAbove(interruptIndex, -1);
      // The second modifying thread is only created after the first one is settled.
      assert.isAbove(createIndex, interruptIndex);

      const launch = yield* store.latestFallbackLaunch(started.monitor.id);
      assert.strictEqual(launch?.status, "launched");
      const monitor = yield* store.getById(started.monitor.id);
      assert.strictEqual(monitor?.ownerThreadId, result.fallbackThreadId);
    }),
  );

  it.effect("records fallback intent before any worktree or thread side effect", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 66,
      });

      preparePrWorktreePath = null;
      const failed = yield* Effect.result(
        monitors.launchFallback({ monitorId: started.monitor.id, reason: "owner-missing" }),
      );
      preparePrWorktreePath = "/tmp/pr-head";
      assert.strictEqual(failed._tag, "Failure");

      const launch = yield* store.latestFallbackLaunch(started.monitor.id);
      assert.isNotNull(launch);
      assert.strictEqual(launch?.status, "failed");
      assert.isNotNull(launch?.error);
      // Ownership never moved, so nothing else can believe the fallback owns the PR.
      const monitor = yield* store.getById(started.monitor.id);
      assert.isNull(monitor?.ownerThreadId ?? null);
    }),
  );
});
