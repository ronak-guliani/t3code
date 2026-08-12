import {
  CommandId,
  MessageId,
  PullRequestMonitorError,
  type PullRequestMonitorActionableEvent,
  type PullRequestMonitorContextInput,
  type PullRequestMonitorContextResult,
  type PullRequestMonitorFeedbackDelivery,
  type PullRequestMonitorFeedbackDeliveryId,
  type PullRequestMonitorFeedbackItem,
  type PullRequestMonitorFeedbackItemId,
  type PullRequestMonitorFeedbackReport,
  type PullRequestMonitorFeedbackRevisionId,
  type PullRequestMonitorId,
  type PullRequestMonitorReadiness,
  type PullRequestMonitorRecord,
  type PullRequestMonitorReportInput,
  type PullRequestMonitorReportResult,
  type PullRequestMonitorSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import { buildWakePrompt } from "./wakePrompt.ts";

/** Debounce window so CI/review bursts batch into one queued delivery. */
export const FEEDBACK_DEBOUNCE_MS = 15_000;
/** After this many consecutive delivery failures, open the circuit. */
export const DELIVERY_CIRCUIT_THRESHOLD = 5;
export const DELIVERY_CIRCUIT_COOLDOWN_MS = 15 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

function isoNow() {
  return Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));
}

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function stableHash(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function stableItemId(monitorId: string, stableKey: string): PullRequestMonitorFeedbackItemId {
  return `fb_item_${stableHash([monitorId, stableKey])}` as PullRequestMonitorFeedbackItemId;
}

function stableRevisionId(
  itemId: string,
  revisionNumber: number,
  sourceRevision: string,
): PullRequestMonitorFeedbackRevisionId {
  return `fb_rev_${stableHash([itemId, String(revisionNumber), sourceRevision])}` as PullRequestMonitorFeedbackRevisionId;
}

function stableDeliveryIds(input: {
  readonly monitorId: string;
  readonly threadId: string;
  readonly revisionIds: ReadonlyArray<string>;
  readonly headSha: string;
}) {
  const batchKey = `fb_batch_${stableHash([input.monitorId, input.threadId, ...input.revisionIds, input.headSha])}`;
  const deliveryId = `fb_del_${stableHash([batchKey])}` as PullRequestMonitorFeedbackDeliveryId;
  const commandId = CommandId.make(`command:pr-monitor-feedback:${batchKey}`);
  const messageId = MessageId.make(`message:pr-monitor-feedback:${batchKey}`);
  return { batchKey, deliveryId, commandId, messageId };
}

function eventStableKey(event: PullRequestMonitorActionableEvent): string {
  return `${event.kind}:${event.sourceId ?? event.detail ?? "na"}`;
}

function eventSummary(event: PullRequestMonitorActionableEvent): string {
  const detail = event.detail ?? event.sourceId ?? event.kind;
  return `${event.kind}: ${detail}`.slice(0, 500);
}

function monitorError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

export class PullRequestMonitorFeedbackService extends Context.Service<
  PullRequestMonitorFeedbackService,
  {
    readonly ingestSnapshot: (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly snapshot: PullRequestMonitorSnapshot;
      readonly readiness: PullRequestMonitorReadiness;
      readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
    }) => Effect.Effect<void, PullRequestMonitorError>;
    readonly flushDueDeliveries: Effect.Effect<void>;
    readonly context: (
      input: PullRequestMonitorContextInput & {
        readonly resolveMonitor: () => Effect.Effect<
          PullRequestMonitorRecord | null,
          PullRequestMonitorError
        >;
      },
    ) => Effect.Effect<PullRequestMonitorContextResult, PullRequestMonitorError>;
    readonly report: (
      input: PullRequestMonitorReportInput & {
        readonly resolveMonitor: () => Effect.Effect<
          PullRequestMonitorRecord,
          PullRequestMonitorError
        >;
        readonly requestRecheck: (
          monitor: PullRequestMonitorRecord,
        ) => Effect.Effect<void, PullRequestMonitorError>;
      },
    ) => Effect.Effect<PullRequestMonitorReportResult, PullRequestMonitorError>;
    readonly listOpenItems: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackItem>, PullRequestMonitorError>;
    readonly listDeliveries: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
    readonly listReports: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackReport>, PullRequestMonitorError>;
  }
>()("t3/pullRequestMonitor/PullRequestMonitorFeedbackService") {}

export const layer = Layer.effect(
  PullRequestMonitorFeedbackService,
  Effect.gen(function* () {
    const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
    const monitorStore = yield* PullRequestMonitorStore.make;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const threads = yield* ThreadManagement.ThreadManagementService;

    const listOpenItems = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listItems({ monitorId, includeClosed: false });
    const listDeliveries = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listDeliveries({ monitorId, limit: 20 });
    const listReports = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listReports({ monitorId, limit: 20 });

    const ingestSnapshot: (typeof PullRequestMonitorFeedbackService.Service)["ingestSnapshot"] = (
      input,
    ) =>
      Effect.gen(function* () {
        if (input.events.length === 0) return;
        if (input.snapshot.state !== "open") return;
        // Persist durable items/revisions even without an owner. Delivery waits for an
        // owner (phase 5+); skipping ingest would lose events once the cursor advances.

        const now = yield* isoNow();
        const newRevisionIds: string[] = [];

        for (const event of input.events) {
          // Terminal state changes are not remediation work.
          if (event.kind === "state-changed") continue;

          const stableKey = eventStableKey(event);
          const itemId = stableItemId(input.monitor.id, stableKey);
          const existing = yield* feedbackStore.getItem(itemId);
          const summary = eventSummary(event);

          if (!existing) {
            yield* feedbackStore.upsertOpenItem({
              item: {
                id: itemId,
                monitorId: input.monitor.id,
                stableKey,
                kind: event.kind,
                status: "open",
                disposition: null,
                dispositionNote: null,
                dispositionAt: null,
                dispositionByThreadId: null,
                firstSeenAt: now,
                lastSeenAt: now,
                currentRevisionId: null,
                summary,
              },
            });
          } else if (existing.status === "closed" && existing.disposition === "resolved") {
            // Re-open only when the same finding resurfaces after resolve.
            yield* feedbackStore.upsertOpenItem({
              item: {
                ...existing,
                status: "open",
                disposition: null,
                dispositionNote: null,
                dispositionAt: null,
                dispositionByThreadId: null,
                lastSeenAt: now,
                summary,
              },
            });
          } else if (
            existing.disposition === "rejected" ||
            existing.disposition === "needs-human"
          ) {
            // Human/agent already classified; do not re-wake on the same stable key.
            continue;
          } else {
            yield* feedbackStore.upsertOpenItem({
              item: {
                ...existing,
                lastSeenAt: now,
                summary,
              },
            });
          }

          const revisionNumber = yield* feedbackStore.nextRevisionNumber(itemId);
          const revisionId = stableRevisionId(
            itemId,
            revisionNumber,
            input.snapshot.sourceRevision,
          );
          yield* feedbackStore.insertRevision({
            id: revisionId,
            itemId,
            revisionNumber,
            sourceRevision: input.snapshot.sourceRevision,
            headSha: input.snapshot.headSha,
            createdAt: now,
            summary,
            payload: {
              event,
              // Bound excerpts only in durable payload; full bodies stay on the provider.
              titleExcerpt: input.snapshot.titleExcerpt,
              url: input.snapshot.url,
            },
          });
          newRevisionIds.push(revisionId);
        }

        if (newRevisionIds.length === 0) return;

        yield* feedbackStore.appendPendingRevisionIds({
          monitorId: input.monitor.id,
          revisionIds: newRevisionIds,
          debounceUntil: addMs(now, FEEDBACK_DEBOUNCE_MS),
          updatedAt: now,
        });
      });

    const revalidateForDelivery = (monitor: PullRequestMonitorRecord) =>
      Effect.gen(function* () {
        if (!monitor.enabled || monitor.status === "stopped" || monitor.status === "terminal") {
          return yield* Effect.fail(monitorError("Monitor is not active for delivery."));
        }
        if (!monitor.ownerThreadId) {
          return yield* Effect.fail(monitorError("Monitor has no owner thread for delivery."));
        }

        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: monitor.projectId,
            repository: monitor.repository,
            number: monitor.number,
          }),
        );
        if (Result.isFailure(snapshotResult)) {
          return yield* Effect.fail(
            monitorError("Fresh monitor snapshot failed before delivery.", snapshotResult.failure),
          );
        }
        const snapshot = snapshotResult.success;
        if (snapshot.state !== "open") {
          return yield* Effect.fail(monitorError("Pull request is no longer open."));
        }
        if (monitor.headSha && snapshot.headSha !== monitor.headSha) {
          // Head moved since the batched revisions; suppress this batch and let next poll rebuild.
          return yield* Effect.fail(monitorError("Pull request head changed before delivery."));
        }
        return { snapshot, ownerThreadId: monitor.ownerThreadId as ThreadId };
      });

    const deliverOne = (delivery: PullRequestMonitorFeedbackDelivery) =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        const monitor = yield* monitorStore.getById(delivery.monitorId);
        if (!monitor) {
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "suppressed",
            lastError: "Monitor missing",
            nextAttemptAt: null,
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const state = yield* feedbackStore.getState(monitor.id);
        if (state.circuitOpenUntil && state.circuitOpenUntil > now) {
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "failed",
            attemptCount: delivery.attemptCount,
            lastError: "Circuit open",
            nextAttemptAt: state.circuitOpenUntil,
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const validated = yield* Effect.result(revalidateForDelivery(monitor));
        if (Result.isFailure(validated)) {
          const attemptCount = delivery.attemptCount + 1;
          const message =
            validated.failure instanceof Error
              ? validated.failure.message
              : String(validated.failure);
          const suppressedByRevalidation =
            /no longer open|no owner thread|not active|head changed/i.test(message);
          const terminal = suppressedByRevalidation || attemptCount >= MAX_DELIVERY_ATTEMPTS;
          if (suppressedByRevalidation) {
            yield* feedbackStore.setDeliveryCircuitState({
              monitorId: state.monitorId,
              deliveryFailureCount: 0,
              circuitOpenUntil: null,
              updatedAt: now,
            });
          } else {
            const failureCount = state.deliveryFailureCount + 1;
            const circuitOpenUntil =
              failureCount >= DELIVERY_CIRCUIT_THRESHOLD
                ? addMs(now, DELIVERY_CIRCUIT_COOLDOWN_MS)
                : state.circuitOpenUntil;
            yield* feedbackStore.setDeliveryCircuitState({
              monitorId: state.monitorId,
              deliveryFailureCount: failureCount,
              circuitOpenUntil,
              updatedAt: now,
            });
          }
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: terminal ? "suppressed" : "failed",
            attemptCount,
            lastError: message.slice(0, 1000),
            nextAttemptAt: terminal
              ? null
              : addMs(now, Math.min(60_000 * 2 ** Math.min(attemptCount, 5), 30 * 60_000)),
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const { snapshot, ownerThreadId } = validated.success;
        const readiness = monitor.readiness ?? {
          ready: false,
          label: "blocked" as const,
          blockers: [{ kind: "checks-missing" as const }],
        };

        // Reconstruct a minimal event list from revision payloads is optional; wake with empty events uses context tool.
        const prompt = buildWakePrompt({
          prNumber: monitor.number,
          repository: monitor.repository,
          deliveryId: delivery.id,
          events: [],
          snapshot,
          readiness,
        });

        const sendResult = yield* Effect.result(
          threads.sendToThread({
            projectId: monitor.projectId,
            commandId: CommandId.make(delivery.commandId),
            threadId: ownerThreadId,
            messageId: MessageId.make(delivery.messageId),
            text: prompt,
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          }),
        );

        if (Result.isFailure(sendResult)) {
          const attemptCount = delivery.attemptCount + 1;
          const message =
            sendResult.failure instanceof Error
              ? sendResult.failure.message
              : String(sendResult.failure);
          const failureCount = state.deliveryFailureCount + 1;
          const circuitOpenUntil =
            failureCount >= DELIVERY_CIRCUIT_THRESHOLD
              ? addMs(now, DELIVERY_CIRCUIT_COOLDOWN_MS)
              : state.circuitOpenUntil;
          yield* feedbackStore.setDeliveryCircuitState({
            monitorId: state.monitorId,
            deliveryFailureCount: failureCount,
            circuitOpenUntil,
            updatedAt: now,
          });
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: attemptCount >= MAX_DELIVERY_ATTEMPTS ? "suppressed" : "failed",
            attemptCount,
            lastError: message.slice(0, 1000),
            nextAttemptAt:
              attemptCount >= MAX_DELIVERY_ATTEMPTS
                ? null
                : addMs(now, Math.min(60_000 * 2 ** Math.min(attemptCount, 5), 30 * 60_000)),
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        yield* feedbackStore.updateDelivery({
          ...delivery,
          status: "delivered",
          attemptCount: delivery.attemptCount + 1,
          lastError: null,
          nextAttemptAt: null,
          deliveredAt: now,
          receiptJson: encodeUnknownJson({
            delivery: sendResult.success.delivery,
            runId: sendResult.success.run.id,
            messageId: sendResult.success.message.id,
          }),
        });
        yield* feedbackStore.setDeliveryCircuitState({
          monitorId: state.monitorId,
          deliveryFailureCount: 0,
          circuitOpenUntil: null,
          updatedAt: now,
        });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Feedback delivery failed", { cause })),
      );

    const materializePendingBatches = Effect.gen(function* () {
      const now = yield* isoNow();
      const monitors = yield* monitorStore.list({ enabledOnly: true });
      for (const monitor of monitors) {
        if (!monitor.ownerThreadId) continue;
        const state = yield* feedbackStore.getState(monitor.id);
        if (state.pendingRevisionIds.length === 0) continue;
        if (state.debounceUntil && state.debounceUntil > now) continue;
        if (state.circuitOpenUntil && state.circuitOpenUntil > now) continue;

        const revisionIds = [...state.pendingRevisionIds].sort();
        const ids = stableDeliveryIds({
          monitorId: monitor.id,
          threadId: monitor.ownerThreadId,
          revisionIds,
          headSha: monitor.headSha ?? "unknown",
        });

        const existing = yield* feedbackStore.getDeliveryByBatchKey(ids.batchKey);
        if (!existing) {
          const delivery: PullRequestMonitorFeedbackDelivery = {
            id: ids.deliveryId,
            monitorId: monitor.id,
            batchKey: ids.batchKey,
            targetThreadId: monitor.ownerThreadId,
            commandId: ids.commandId,
            messageId: ids.messageId,
            revisionIds:
              revisionIds as unknown as ReadonlyArray<PullRequestMonitorFeedbackRevisionId>,
            status: "pending",
            attemptCount: 0,
            lastError: null,
            createdAt: now,
            deliveredAt: null,
          };
          yield* feedbackStore.insertDelivery({
            ...delivery,
            nextAttemptAt: now,
            receiptJson: null,
          });
        }

        yield* feedbackStore.removePendingRevisionIds({
          monitorId: monitor.id,
          revisionIds,
          updatedAt: now,
        });
      }
    }).pipe(Effect.ignore);

    const flushDueDeliveries = materializePendingBatches.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const now = yield* isoNow();
          const due = yield* feedbackStore.listDueDeliveries(now, 16);
          // Group by monitor so circuit/order updates cannot race within one monitor.
          const byMonitor = new Map<string, typeof due>();
          for (const delivery of due) {
            const group = byMonitor.get(delivery.monitorId) ?? [];
            group.push(delivery);
            byMonitor.set(delivery.monitorId, group);
          }
          yield* Effect.forEach(
            [...byMonitor.values()],
            (group) => Effect.forEach(group, deliverOne, { concurrency: 1 }),
            { concurrency: 2 },
          );
        }),
      ),
      Effect.ignore,
    );

    // Background flusher for debounce maturity + retries.
    yield* flushDueDeliveries.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(5))),
      Effect.forever,
      Effect.forkScoped,
      Effect.interruptible,
    );
    yield* Stream.fromSchedule(Schedule.spaced(Duration.seconds(20))).pipe(
      Stream.mapEffect(() => flushDueDeliveries),
      Stream.runDrain,
      Effect.forkScoped,
      Effect.interruptible,
    );

    const context: (typeof PullRequestMonitorFeedbackService.Service)["context"] = (input) =>
      Effect.gen(function* () {
        const monitor = yield* input.resolveMonitor();
        if (!monitor) {
          return {
            monitor: null,
            latestSnapshot: null,
            items: [],
            recentDeliveries: [],
            recentReports: [],
          };
        }
        const latest = yield* monitorStore.latestSnapshot(monitor.id);
        const items = yield* feedbackStore.listItems({
          monitorId: monitor.id,
          includeClosed: input.includeClosed === true,
        });
        const recentDeliveries = yield* listDeliveries(monitor.id);
        const recentReports = yield* listReports(monitor.id);
        return {
          monitor,
          latestSnapshot: latest?.snapshot ?? null,
          items,
          recentDeliveries,
          recentReports,
        };
      });

    const report: (typeof PullRequestMonitorFeedbackService.Service)["report"] = (input) =>
      Effect.gen(function* () {
        const monitor = yield* input.resolveMonitor();
        const item = yield* feedbackStore.getItem(input.itemId);
        if (!item || item.monitorId !== monitor.id) {
          return yield* Effect.fail(monitorError("Feedback item was not found on this monitor."));
        }
        const now = yield* isoNow();
        const status =
          input.disposition === "accepted" || input.disposition === "needs-human"
            ? "open"
            : "closed";
        const reportRow: PullRequestMonitorFeedbackReport = {
          id: `fb_report_${stableHash([monitor.id, item.id, input.disposition, now])}`,
          monitorId: monitor.id,
          itemId: item.id,
          disposition: input.disposition,
          note: input.note ?? null,
          reporterThreadId: input.reporterThreadId ?? null,
          createdAt: now,
        };
        yield* feedbackStore.reportDisposition({
          itemId: item.id,
          disposition: input.disposition,
          note: input.note ?? null,
          at: now,
          byThreadId: input.reporterThreadId ?? null,
          status,
          report: reportRow,
        });
        // Immediate post-report recheck so dispositions are verified against fresh PR state.
        yield* input.requestRecheck(monitor);
        const fresh = yield* feedbackStore.getItem(item.id);
        return {
          item: fresh ?? { ...item, disposition: input.disposition, status, dispositionAt: now },
          report: reportRow,
          recheckRequested: true,
        };
      });

    return PullRequestMonitorFeedbackService.of({
      ingestSnapshot,
      flushDueDeliveries,
      context,
      report,
      listOpenItems,
      listDeliveries,
      listReports,
    });
  }),
);
