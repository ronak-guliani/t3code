import {
  CommandId,
  MessageId,
  PullRequestMonitorError,
  PullRequestMonitorId,
  type PullRequestMonitorListInput,
  type PullRequestMonitorListResult,
  type PullRequestMonitorMutationResult,
  type PullRequestMonitorRecord,
  type PullRequestMonitorStartInput,
  type PullRequestMonitorStatusInput,
  type PullRequestMonitorStatusResult,
  type PullRequestMonitorStopInput,
  type PullRequestMonitorReportInput,
  type PullRequestMonitorReportResult,
  type PullRequestMonitorContextInput,
  type PullRequestMonitorContextResult,
  type PullRequestMonitorTransferInput,
  type PullRequestMonitorSubmitFindingsInput,
  type PullRequestMonitorSubmitFindingsResult,
  type PullRequestMonitorLaunchFallbackInput,
  type PullRequestMonitorLaunchFallbackResult,
  type PullRequestMonitorFallbackReason,
  type PullRequestRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { formatPullRequestMonitorCanonicalKey } from "./canonicalKey.ts";
import { diffPullRequestMonitorSnapshot, emptyCursor } from "./monitorDiff.ts";
import {
  abandonFallbackThread,
  createFallbackThread,
  requireProjectThread as requireProjectThreadV1,
  resolveOwnerAvailability,
  startFallbackTurn,
  waitForThreadWorktree,
} from "./v1ThreadBridge.ts";
import {
  HOST_COOLDOWN_MS,
  LEASE_TTL_MS,
  nextPollDelayMs,
  POLL_CONCURRENCY,
} from "./pollSchedule.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";
import { computeReadiness } from "./readiness.ts";
import { PullRequestMonitorFeedbackService } from "./PullRequestMonitorFeedbackService.ts";
import { buildFallbackMaintenancePrompt, formatBlockersSummary } from "./wakePrompt.ts";

/** Minimum gap between successful/attempted fallback launches per monitor. */
const FALLBACK_COOLDOWN_MS = 30 * 60 * 1000;
/** Exclusive claim while a fallback launch is materializing a worktree/thread. */
const FALLBACK_LAUNCH_LEASE_MS = 3 * 60 * 1000;

function isoNow() {
  return Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));
}

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

function monitorError(
  message: string,
  input?: { monitorId?: PullRequestMonitorId; cause?: unknown },
) {
  return new PullRequestMonitorError({
    message,
    ...(input?.monitorId === undefined ? {} : { monitorId: input.monitorId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export class PullRequestMonitorService extends Context.Service<
  PullRequestMonitorService,
  {
    readonly start: (
      input: PullRequestMonitorStartInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly stop: (
      input: PullRequestMonitorStopInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly status: (
      input: PullRequestMonitorStatusInput,
    ) => Effect.Effect<PullRequestMonitorStatusResult, PullRequestMonitorError>;
    readonly list: (
      input: PullRequestMonitorListInput,
    ) => Effect.Effect<PullRequestMonitorListResult, PullRequestMonitorError>;
    readonly subscribeList: (
      input: PullRequestMonitorListInput,
    ) => Stream.Stream<PullRequestMonitorListResult, PullRequestMonitorError>;
    readonly pollOnce: Effect.Effect<void>;
    readonly context: (
      input: PullRequestMonitorContextInput,
    ) => Effect.Effect<PullRequestMonitorContextResult, PullRequestMonitorError>;
    readonly report: (
      input: PullRequestMonitorReportInput,
    ) => Effect.Effect<PullRequestMonitorReportResult, PullRequestMonitorError>;
    readonly transferOwnership: (
      input: PullRequestMonitorTransferInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly submitFindings: (
      input: PullRequestMonitorSubmitFindingsInput,
    ) => Effect.Effect<PullRequestMonitorSubmitFindingsResult, PullRequestMonitorError>;
    readonly launchFallback: (
      input: PullRequestMonitorLaunchFallbackInput,
    ) => Effect.Effect<PullRequestMonitorLaunchFallbackResult, PullRequestMonitorError>;
  }
>()("t3/pullRequestMonitor/PullRequestMonitorService") {}

export const layer = Layer.effect(
  PullRequestMonitorService,
  Effect.gen(function* () {
    const store = yield* PullRequestMonitorStore.make;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const feedback = yield* PullRequestMonitorFeedbackService;
    const serverSettings = yield* ServerSettingsService;
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitManager;
    const crypto = yield* Crypto.Crypto;
    const ownerId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const changes = yield* PubSub.sliding<void>(1);
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

    const ownerAvailability = (ownerThreadId: ThreadId | null) =>
      resolveOwnerAvailability(ownerThreadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
      );

    const requireProjectThread = (input: {
      projectId: PullRequestMonitorRecord["projectId"];
      threadId: ThreadId;
    }) =>
      requireProjectThreadV1(input).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
        Effect.mapError((cause) =>
          monitorError("Target thread is missing, deleted, or outside this monitor project.", {
            cause,
          }),
        ),
      );

    const resolveMonitor = (input: {
      readonly monitorId?: PullRequestMonitorId | undefined;
      readonly reference?: PullRequestRef | undefined;
    }) =>
      Effect.gen(function* () {
        if (input.monitorId) {
          const byId = yield* store.getById(input.monitorId);
          if (byId) return byId;
        }
        if (input.reference) {
          const byRef = yield* store.getByProjectRef({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number: input.reference.number,
          });
          if (byRef) return byRef;
        }
        return yield* Effect.fail(monitorError("Pull request monitor was not found."));
      });

    const list = (input: PullRequestMonitorListInput = {}) =>
      store
        .list({
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.enabledOnly !== undefined ? { enabledOnly: input.enabledOnly } : {}),
        })
        .pipe(Effect.map((monitors) => ({ monitors })));

    const status = (input: PullRequestMonitorStatusInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input).pipe(
          Effect.catchTag("PullRequestMonitorError", () => Effect.succeed(null)),
        );
        if (!monitor) {
          return {
            monitor: null,
            latestSnapshot: null,
            recentEvents: [],
            openFeedback: [],
            recentDeliveries: [],
            recentReports: [],
          };
        }
        const latest = yield* store.latestSnapshot(monitor.id);
        const openFeedback = yield* feedback.listOpenItems(monitor.id);
        const recentDeliveries = yield* feedback.listDeliveries(monitor.id);
        const recentReports = yield* feedback.listReports(monitor.id);
        return {
          monitor,
          latestSnapshot: latest?.snapshot ?? null,
          recentEvents: latest?.events ?? [],
          openFeedback,
          recentDeliveries,
          recentReports,
        };
      });

    const start = (input: PullRequestMonitorStartInput) =>
      Effect.gen(function* () {
        // Fresh detail resolves host/provider identity; never trust client-only identity.
        const detail = yield* pullRequests
          .detail(input)
          .pipe(
            Effect.mapError((cause) =>
              monitorError("Could not resolve pull request for monitoring.", { cause }),
            ),
          );

        const host = (() => {
          try {
            return new URL(detail.url).host;
          } catch {
            return detail.provider === "github" ? "github.com" : detail.provider;
          }
        })();

        const canonical = formatPullRequestMonitorCanonicalKey({
          provider: detail.provider,
          host,
          repository: detail.repository,
          number: detail.number,
        });

        const existing = yield* store.getByCanonicalKey(canonical);
        const now = yield* isoNow();

        if (existing) {
          if (existing.projectId !== input.projectId) {
            return yield* monitorError(
              "This pull request is already monitored by another project.",
              { monitorId: existing.id },
            );
          }
          const nextOwner = input.ownerThreadId ?? existing.ownerThreadId;
          // Ownership-scoped write so a concurrent poll cannot be clobbered by start().
          if (nextOwner !== existing.ownerThreadId) {
            if (nextOwner === null) {
              return yield* monitorError("Cannot clear monitor ownership through start().", {
                monitorId: existing.id,
              });
            }
            yield* requireProjectThread({ projectId: existing.projectId, threadId: nextOwner });
            yield* store.transferOwnershipAtomic({
              monitorId: existing.id,
              ownerThreadId: nextOwner,
              updatedAt: now,
              eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
              toThreadId: nextOwner,
              reason: "start-owner-associate",
            });
          }
          const resumed: PullRequestMonitorRecord = {
            ...existing,
            projectId: input.projectId,
            ownerThreadId: nextOwner,
            linkedReviewThreadId: existing.linkedReviewThreadId ?? null,
            status: "monitoring",
            enabled: true,
            lastError: null,
            nextPollAt: now,
            updatedAt: now,
            stoppedAt: null,
          };
          // Explicit resume may re-enable after stop; poll commits cannot.
          yield* store.updatePollState(resumed, undefined, { allowReenable: true });
          yield* notify;
          // Kick an immediate observe pass for the resumed monitor.
          yield* pollMonitor(resumed).pipe(Effect.ignore);
          const fresh = yield* store.getById(resumed.id);
          return { monitor: fresh ?? resumed };
        }

        const ownerThreadId = input.ownerThreadId ?? null;
        if (ownerThreadId !== null) {
          yield* requireProjectThread({ projectId: input.projectId, threadId: ownerThreadId });
        }

        const id = PullRequestMonitorId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const record: PullRequestMonitorRecord = {
          id,
          canonicalKey: canonical,
          provider: detail.provider,
          host,
          repository: detail.repository,
          number: detail.number,
          projectId: input.projectId,
          ownerThreadId,
          linkedReviewThreadId: null,
          status: "monitoring",
          enabled: true,
          readiness: null,
          headSha: null,
          sourceRevision: null,
          lastPolledAt: null,
          nextPollAt: now,
          lastError: null,
          pollFailureCount: 0,
          createdAt: now,
          updatedAt: now,
          stoppedAt: null,
        };
        yield* store.insert(record, emptyCursor());
        yield* notify;
        yield* pollMonitor(record).pipe(Effect.ignore);
        const fresh = yield* store.getById(id);
        return { monitor: fresh ?? record };
      });

    const stop = (input: PullRequestMonitorStopInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        const now = yield* isoNow();
        const stopped: PullRequestMonitorRecord = {
          ...monitor,
          enabled: false,
          status: "stopped",
          nextPollAt: null,
          updatedAt: now,
          stoppedAt: now,
        };
        // Poll/lifecycle fields only — preserve concurrent ownership handoffs.
        yield* store.updatePollState(stopped);
        yield* store.releaseLease(monitor.canonicalKey, ownerId);
        yield* notify;
        return { monitor: stopped };
      });

    const pollMonitor = (monitor: PullRequestMonitorRecord): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        const hostKey = `${monitor.provider}:${monitor.host}`;
        const cooldownUntil = yield* store.getHostCooldownUntil(hostKey, now);
        if (cooldownUntil) {
          const deferred: PullRequestMonitorRecord = {
            ...monitor,
            nextPollAt: cooldownUntil,
            updatedAt: now,
          };
          yield* store.updatePollState(deferred);
          return;
        }

        const leased = yield* store.tryAcquireLease({
          canonicalKey: monitor.canonicalKey,
          ownerId,
          nowIso: now,
          expiresAt: addMs(now, LEASE_TTL_MS),
        });
        if (!leased) return;

        const cursor = yield* store.getCursor(monitor.id);
        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: monitor.projectId,
            repository: monitor.repository,
            number: monitor.number,
          }),
        );

        if (Result.isFailure(snapshotResult)) {
          const failureCount = monitor.pollFailureCount + 1;
          const delay = yield* nextPollDelayMs({
            readiness: monitor.readiness,
            failureCount,
            hadActionableEvents: false,
          });
          const message =
            snapshotResult.failure instanceof Error
              ? snapshotResult.failure.message
              : String(snapshotResult.failure);
          if (/rate limit|secondary rate|403/i.test(message)) {
            yield* store.setHostCooldown({
              hostKey,
              cooldownUntil: addMs(now, HOST_COOLDOWN_MS),
              reason: message.slice(0, 300),
              nowIso: now,
            });
          }
          const failed: PullRequestMonitorRecord = {
            ...monitor,
            status: "error",
            lastError: message.slice(0, 1000),
            pollFailureCount: failureCount,
            lastPolledAt: now,
            nextPollAt: addMs(now, delay),
            updatedAt: now,
          };
          yield* store.updatePollState(failed);
          yield* store.releaseLease(monitor.canonicalKey, ownerId);
          yield* notify;
          return;
        }

        const snapshot = snapshotResult.success;
        const { actionableEvents, nextCursor } = diffPullRequestMonitorSnapshot(cursor, snapshot);
        const readiness = computeReadiness(snapshot, cursor.threadVersions, monitor.createdAt);

        let status: PullRequestMonitorRecord["status"] = "monitoring";
        if (snapshot.state !== "open") status = "terminal";
        else if (readiness.ready) status = "ready";

        const delay = yield* nextPollDelayMs({
          readiness,
          failureCount: 0,
          hadActionableEvents: actionableEvents.length > 0,
        });

        // Ready PRs stay monitored slowly; terminal PRs stop polling.
        const enabled = status !== "terminal";
        const updated: PullRequestMonitorRecord = {
          ...monitor,
          status,
          enabled,
          readiness,
          headSha: snapshot.headSha,
          sourceRevision: snapshot.sourceRevision,
          lastPolledAt: now,
          nextPollAt: enabled ? addMs(now, delay) : null,
          lastError: null,
          pollFailureCount: 0,
          updatedAt: now,
          stoppedAt: enabled ? null : now,
        };

        const snapshotId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        // Persist observed snapshot for audit, then ingest feedback before advancing the
        // cursor so a transient ingest failure cannot permanently drop actionable events.
        yield* store.saveSnapshot({
          snapshotId,
          monitorId: monitor.id,
          snapshot,
          readiness,
          events: actionableEvents,
        });
        if (actionableEvents.length > 0) {
          yield* feedback.ingestSnapshot({
            monitor: updated,
            snapshot,
            readiness,
            events: actionableEvents,
          });
          yield* store.updatePollState(updated, nextCursor);
        } else {
          yield* store.updatePollState(updated, nextCursor);
        }

        // Auto fallback only when owner is explicitly missing/unavailable and there is work.
        // Fail closed on settings/read errors and operational projection failures.
        if (actionableEvents.length > 0 && snapshot.state === "open" && updated.enabled) {
          const availability = yield* ownerAvailability(updated.ownerThreadId);
          if (availability.kind === "unavailable") {
            const settingsResult = yield* Effect.result(serverSettings.getSettings);
            if (
              Result.isSuccess(settingsResult) &&
              settingsResult.success.autoLaunchPrMonitorFallback === true
            ) {
              yield* launchFallback({
                monitorId: updated.id,
                reason: availability.reason,
              }).pipe(Effect.ignore);
            }
          }
        }

        yield* store.releaseLease(monitor.canonicalKey, ownerId);
        yield* notify;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const now = yield* isoNow();
            const failureCount = monitor.pollFailureCount + 1;
            const delay = yield* nextPollDelayMs({
              readiness: monitor.readiness,
              failureCount,
              hadActionableEvents: false,
            });
            yield* store.updatePollState({
              ...monitor,
              status: "error",
              lastError: String(cause).slice(0, 1000),
              pollFailureCount: failureCount,
              lastPolledAt: now,
              nextPollAt: addMs(now, delay),
              updatedAt: now,
            });
            yield* store.releaseLease(monitor.canonicalKey, ownerId);
            yield* notify;
          }).pipe(Effect.ignore),
        ),
      );

    const pollOnce = Effect.gen(function* () {
      const now = yield* isoNow();
      const due = yield* store.listDue(now, 32);
      yield* Effect.forEach(due, (monitor) => pollMonitor(monitor), {
        concurrency: POLL_CONCURRENCY,
      });
    }).pipe(Effect.ignore);

    // Background adaptive poller. Observe-only: no turn steering.
    yield* pollOnce.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(15))),
      Effect.forever,
      Effect.forkScoped,
      Effect.interruptible,
    );

    // Safety wake if clocks/leases stall.
    yield* Stream.fromSchedule(Schedule.spaced(Duration.seconds(30))).pipe(
      Stream.mapEffect(() => pollOnce),
      Stream.runDrain,
      Effect.forkScoped,
      Effect.interruptible,
    );

    const requestRecheck = (monitor: PullRequestMonitorRecord) =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        yield* store.scheduleRecheck({
          monitorId: monitor.id,
          nextPollAt: now,
          updatedAt: now,
        });
      });

    const context = (input: PullRequestMonitorContextInput) =>
      feedback.context({
        ...input,
        resolveMonitor: () =>
          resolveMonitor({
            ...(input.monitorId === undefined ? {} : { monitorId: input.monitorId }),
            ...(input.reference === undefined ? {} : { reference: input.reference }),
          }).pipe(Effect.catchTag("PullRequestMonitorError", () => Effect.succeed(null))),
      });

    const report = (input: PullRequestMonitorReportInput) =>
      feedback.report({
        ...input,
        resolveMonitor: () =>
          resolveMonitor({
            ...(input.monitorId === undefined ? {} : { monitorId: input.monitorId }),
            ...(input.reference === undefined ? {} : { reference: input.reference }),
          }),
        requestRecheck,
      });

    const transferOwnership = (input: PullRequestMonitorTransferInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        if (monitor.ownerThreadId === input.toThreadId) {
          return { monitor };
        }
        yield* requireProjectThread({ projectId: monitor.projectId, threadId: input.toThreadId });
        // Never allow two concurrent modifying owners: transfer replaces the single owner.
        const now = yield* isoNow();
        const updated = {
          ...monitor,
          ownerThreadId: input.toThreadId,
          updatedAt: now,
        };
        yield* store.transferOwnershipAtomic({
          monitorId: monitor.id,
          ownerThreadId: input.toThreadId,
          updatedAt: now,
          eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          toThreadId: input.toThreadId,
          reason: input.reason ?? "transfer",
        });
        yield* notify;
        return { monitor: updated };
      });

    const submitFindings = (input: PullRequestMonitorSubmitFindingsInput) =>
      Effect.gen(function* () {
        const startMonitoring = input.startMonitoring !== false;
        // Start without mutating ownership so handoff audit sees the true previous owner.
        let monitorRecord: PullRequestMonitorRecord;
        if (startMonitoring) {
          const started = yield* start({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number: input.reference.number,
          });
          monitorRecord = started.monitor;
        } else {
          monitorRecord = yield* resolveMonitor({ reference: input.reference });
        }

        yield* requireProjectThread({
          projectId: monitorRecord.projectId,
          threadId: input.reviewThreadId,
        });
        const ownerThreadId =
          input.ownerThreadId ?? monitorRecord.ownerThreadId ?? (null as ThreadId | null);
        if (ownerThreadId !== null) {
          yield* requireProjectThread({
            projectId: monitorRecord.projectId,
            threadId: ownerThreadId,
          });
        }
        const now = yield* isoNow();
        const updated = {
          ...monitorRecord,
          linkedReviewThreadId: input.reviewThreadId,
          ownerThreadId,
          updatedAt: now,
        };
        // Always use ownership-scoped SQL so concurrent poll updates cannot clobber the link.
        yield* store.transferOwnershipAtomic({
          monitorId: updated.id,
          ownerThreadId,
          linkedReviewThreadId: input.reviewThreadId,
          updatedAt: now,
          eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          toThreadId: ownerThreadId,
          reason: input.summary?.slice(0, 500) ?? "review-handoff",
        });
        yield* notify;
        return {
          monitor: updated,
          linkedReviewThreadId: input.reviewThreadId,
          ownerThreadId,
          monitoringStarted: startMonitoring,
        };
      });

    const waitForPreparedWorktree = (threadId: ThreadId) =>
      waitForThreadWorktree(threadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
      );

    const abandonFallback = (input: {
      readonly projectId: PullRequestMonitorRecord["projectId"];
      readonly threadId: ThreadId;
      readonly commandIdPrefix: string;
    }) =>
      abandonFallbackThread({
        threadId: input.threadId,
        commandIdPrefix: input.commandIdPrefix,
      }).pipe(Effect.provideService(OrchestrationEngineService, engine));

    const launchFallback = (
      input: PullRequestMonitorLaunchFallbackInput,
    ): Effect.Effect<PullRequestMonitorLaunchFallbackResult, PullRequestMonitorError> =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        if (!monitor.enabled || monitor.status === "terminal") {
          return yield* Effect.fail(
            monitorError("Monitor is not active for fallback launch.", {
              monitorId: monitor.id,
            }),
          );
        }

        const force = input.force === true;
        const now = yield* isoNow();
        const previousOwner = monitor.ownerThreadId;
        const availability = yield* ownerAvailability(previousOwner);
        if (availability.kind === "unknown") {
          return yield* Effect.fail(
            monitorError(
              "Could not verify owner thread availability; refusing fallback takeover.",
              { monitorId: monitor.id, cause: availability.cause },
            ),
          );
        }
        if (availability.kind === "available" && !force) {
          // Cooldown only short-circuits when the recorded fallback owner is still alive.
          const latest = yield* store.latestFallbackLaunch(monitor.id);
          if (latest && latest.status === "launched") {
            const age =
              DateTime.toEpochMillis(DateTime.makeUnsafe(now)) -
              DateTime.toEpochMillis(DateTime.makeUnsafe(latest.createdAt));
            const existingThread = latest.threadId as ThreadId | null;
            if (
              age >= 0 &&
              age < FALLBACK_COOLDOWN_MS &&
              existingThread &&
              previousOwner === existingThread
            ) {
              return {
                monitor,
                fallbackThreadId: existingThread,
                previousOwnerThreadId: null,
                launched: false,
                skippedReason: "recent-fallback-cooldown",
                commandId: latest.commandId,
              };
            }
          }
          return yield* Effect.fail(
            monitorError(
              "Owner thread is still available. Use force only with explicit human approval, or transfer ownership first.",
              { monitorId: monitor.id },
            ),
          );
        }

        // Serialize concurrent fallback attempts (RPC + auto path) with a short exclusive lease.
        const attemptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const fallbackLeaseKey = `fallback:${monitor.canonicalKey}`;
        const leased = yield* store.tryAcquireLease({
          canonicalKey: fallbackLeaseKey,
          ownerId: attemptId,
          nowIso: now,
          expiresAt: addMs(now, FALLBACK_LAUNCH_LEASE_MS),
        });
        if (!leased) {
          const latest = yield* store.latestFallbackLaunch(monitor.id);
          const inflightThread = latest?.threadId as ThreadId | null | undefined;
          if (latest && inflightThread) {
            return {
              monitor,
              fallbackThreadId: inflightThread,
              previousOwnerThreadId: null,
              launched: false,
              skippedReason: "fallback-launch-in-flight",
              commandId: latest.commandId,
            };
          }
          return yield* Effect.fail(
            monitorError("Another fallback launch is already in progress for this monitor.", {
              monitorId: monitor.id,
            }),
          );
        }

        return yield* Effect.gen(function* () {
          const snapshotResult = yield* Effect.result(
            pullRequests.monitorSnapshot({
              projectId: monitor.projectId,
              repository: monitor.repository,
              number: monitor.number,
            }),
          );
          if (Result.isFailure(snapshotResult)) {
            return yield* Effect.fail(
              monitorError("Could not load PR snapshot for fallback launch.", {
                monitorId: monitor.id,
                cause: snapshotResult.failure,
              }),
            );
          }
          const snapshot = snapshotResult.success;
          if (snapshot.state !== "open") {
            return yield* Effect.fail(
              monitorError("Pull request is not open; refusing fallback launch.", {
                monitorId: monitor.id,
              }),
            );
          }

          const reason: PullRequestMonitorFallbackReason =
            input.reason ??
            (force
              ? "explicit"
              : availability.kind === "unavailable" && availability.reason === "owner-missing"
                ? "owner-missing"
                : "owner-unavailable");

          const commandIdValue = `command:pr-monitor-fallback:${monitor.id}:${attemptId}`;
          const commandId = CommandId.make(commandIdValue);
          const messageId = MessageId.make(
            `message:pr-monitor-fallback:${monitor.id}:${attemptId}`,
          );
          const readiness = monitor.readiness ?? {
            ready: false,
            label: "blocked" as const,
            blockers: [{ kind: "checks-missing" as const, detail: "No readiness yet" }],
          };
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((cause) =>
              monitorError("Could not read settings for fallback launch.", {
                monitorId: monitor.id,
                cause,
              }),
            ),
          );

          const projectShell = yield* projections.getProjectShellById(monitor.projectId).pipe(
            Effect.mapError((cause) =>
              monitorError("Could not resolve project for fallback launch.", {
                monitorId: monitor.id,
                cause,
              }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    monitorError("Project no longer exists for fallback launch.", {
                      monitorId: monitor.id,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );

          // Materialize refs/pull/<n>/head (and fork heads) before creating a thread worktree.
          const prCheckout = yield* Effect.result(
            git.preparePullRequestThread({
              cwd: projectShell.workspaceRoot,
              reference: `#${monitor.number}`,
              mode: "worktree",
            }),
          );
          if (Result.isFailure(prCheckout)) {
            const message =
              prCheckout.failure instanceof Error
                ? prCheckout.failure.message
                : String(prCheckout.failure);
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: null,
              reason,
              status: "failed",
              error: message.slice(0, 1000),
              createdAt: now,
            });
            return yield* Effect.fail(
              monitorError(
                `Could not materialize PR head for fallback launch: ${message.slice(0, 300)}`,
                { monitorId: monitor.id, cause: prCheckout.failure },
              ),
            );
          }
          if (
            prCheckout.success.worktreePath === null ||
            prCheckout.success.worktreePath.length === 0
          ) {
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: null,
              reason,
              status: "failed",
              error: "PR head preparation did not yield a worktree path.",
              createdAt: now,
            });
            return yield* Effect.fail(
              monitorError("PR head preparation did not yield a worktree path.", {
                monitorId: monitor.id,
              }),
            );
          }

          const prompt = buildFallbackMaintenancePrompt({
            prNumber: monitor.number,
            repository: monitor.repository,
            url: snapshot.url,
            headBranch: snapshot.headBranch,
            headSha: snapshot.headSha,
            reason,
            previousOwnerThreadId: previousOwner,
            note: input.note ?? null,
            readinessSummary: formatBlockersSummary(readiness),
          });

          // Create the thread first (no turn). Claim exclusive ownership, then start
          // the maintenance turn so two modifiers can never race on the same PR.
          const createResult = yield* Effect.result(
            createFallbackThread({
              commandId,
              projectId: monitor.projectId,
              title: `PR maintenance ${monitor.repository}#${monitor.number}`,
              modelSelection: settings.textGenerationModelSelection,
              worktreePath: prCheckout.success.worktreePath,
              branch: prCheckout.success.branch,
              pullRequest: {
                number: monitor.number,
                title: snapshot.titleExcerpt || `${monitor.repository}#${monitor.number}`,
                url: snapshot.url,
                baseBranch: snapshot.baseBranch,
                headBranch: snapshot.headBranch,
              },
            }).pipe(Effect.provideService(OrchestrationEngineService, engine)),
          );

          if (Result.isFailure(createResult)) {
            const message =
              createResult.failure instanceof Error
                ? createResult.failure.message
                : String(createResult.failure);
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: null,
              reason,
              status: "failed",
              error: message.slice(0, 1000),
              createdAt: now,
            });
            return yield* Effect.fail(
              monitorError(`Fallback thread create failed: ${message.slice(0, 300)}`, {
                monitorId: monitor.id,
                cause: createResult.failure,
              }),
            );
          }

          const fallbackThreadId = createResult.success.threadId;
          const prepared = yield* waitForPreparedWorktree(fallbackThreadId);
          if (!prepared) {
            yield* abandonFallback({
              projectId: monitor.projectId,
              threadId: fallbackThreadId,
              commandIdPrefix: commandIdValue,
            });
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: fallbackThreadId,
              reason,
              status: "failed",
              error: "Worktree preparation did not complete; ownership was not transferred.",
              createdAt: now,
            });
            return yield* Effect.fail(
              monitorError(
                "Fallback worktree preparation did not complete; ownership was not transferred.",
                { monitorId: monitor.id },
              ),
            );
          }

          const transferred = yield* store.transferOwnershipAtomic({
            monitorId: monitor.id,
            ownerThreadId: fallbackThreadId,
            expectedOwnerThreadId: previousOwner,
            updatedAt: now,
            eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
            toThreadId: fallbackThreadId,
            reason: `fallback:${reason}`,
          });
          if (!transferred) {
            yield* abandonFallback({
              projectId: monitor.projectId,
              threadId: fallbackThreadId,
              commandIdPrefix: commandIdValue,
            });
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: fallbackThreadId,
              reason,
              status: "failed",
              error: "Ownership changed during fallback launch; abandoned prepared thread.",
              createdAt: now,
            });
            return yield* Effect.fail(
              monitorError("Ownership changed during fallback launch; abandoned prepared thread.", {
                monitorId: monitor.id,
              }),
            );
          }

          const turnResult = yield* Effect.result(
            startFallbackTurn({
              threadId: fallbackThreadId,
              commandId: CommandId.make(`${commandIdValue}:turn`),
              messageId,
              text: prompt,
            }).pipe(Effect.provideService(OrchestrationEngineService, engine)),
          );
          if (Result.isFailure(turnResult)) {
            // Ownership already transferred; leave the thread for the operator and surface the error.
            const message =
              turnResult.failure instanceof Error
                ? turnResult.failure.message
                : String(turnResult.failure);
            yield* store.recordFallbackLaunch({
              launchId: attemptId,
              monitorId: monitor.id,
              commandId: commandIdValue,
              threadId: fallbackThreadId,
              reason,
              status: "failed",
              error: `Ownership transferred but turn start failed: ${message.slice(0, 800)}`,
              createdAt: now,
            });
            yield* notify;
            return yield* Effect.fail(
              monitorError(
                `Fallback ownership transferred but turn start failed: ${message.slice(0, 300)}`,
                { monitorId: monitor.id, cause: turnResult.failure },
              ),
            );
          }

          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: fallbackThreadId,
            reason,
            status: "launched",
            error: null,
            createdAt: now,
          });
          yield* notify;

          return {
            monitor: {
              ...monitor,
              ownerThreadId: fallbackThreadId,
              updatedAt: now,
            },
            fallbackThreadId,
            previousOwnerThreadId: previousOwner,
            launched: true,
            skippedReason: null,
            commandId: commandIdValue,
          };
        }).pipe(
          Effect.ensuring(store.releaseLease(fallbackLeaseKey, attemptId).pipe(Effect.orDie)),
        );
      });

    return PullRequestMonitorService.of({
      start,
      stop,
      status,
      list,
      subscribeList: (input) =>
        Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => list(input))),
        ),
      pollOnce,
      context,
      report,
      transferOwnership,
      submitFindings,
      launchFallback,
    });
  }),
);
