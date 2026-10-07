import { CommandId, EventId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StorageCleanupPolicy } from "../../storage/StorageCleanupPolicy.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { TerminalManager } from "../Services/Manager.ts";
import {
  IdleTerminalReaper,
  type IdleTerminalReaperShape,
} from "../Services/IdleTerminalReaper.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_TERMINALS_PER_SWEEP = 25;
const MAX_OLD_PROCESSES_PER_SWEEP = 5;
const HOUR_MS = 60 * 60 * 1_000;

/** Every non-age rule that keeps a chat's terminals running; a reset keeps these. */
export function isThreadBusyForTerminalReaper(thread: OrchestrationThreadShell): boolean {
  return (
    thread.pinnedAt != null ||
    thread.session?.activeTurnId != null ||
    thread.pendingTurnStart != null ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingQueuedTurn ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  );
}

export function isThreadIdleForTerminalReaper(
  thread: OrchestrationThreadShell,
  nowMs: number,
  inactivityThresholdMs: number,
): boolean {
  if (
    !Number.isFinite(inactivityThresholdMs) ||
    inactivityThresholdMs <= 0 ||
    isThreadBusyForTerminalReaper(thread)
  ) {
    return false;
  }

  const activityTimes = [
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt ?? null,
    thread.latestTurn?.startedAt ?? null,
    thread.latestTurn?.completedAt ?? null,
  ];
  const parsedTimes: number[] = [];
  for (const value of activityTimes) {
    if (value === null) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return false;
    parsedTimes.push(timestamp);
  }
  return parsedTimes.length > 0 && Math.max(...parsedTimes) <= nowMs - inactivityThresholdMs;
}

export interface IdleTerminalReaperLiveOptions {
  readonly sweepIntervalMs?: number;
}

const makeIdleTerminalReaper = (options?: IdleTerminalReaperLiveOptions) =>
  Effect.gen(function* () {
    const terminals = yield* TerminalManager;
    const projection = yield* ProjectionSnapshotQuery;
    const previews = yield* PreviewManager;
    const orchestration = yield* OrchestrationEngineService;
    const storagePolicy = yield* StorageCleanupPolicy;
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    let priorProcessCursor = 0;
    let terminalCursor = 0;

    // Idle stopping is automatic cleanup: paused by the master switch. Stopping
    // proven-owned processes of archived/deleted chats left by a previous
    // server instance is leak correction and keeps running (stopPriorProcesses
    // with a null threshold).
    const readThresholdMs = Effect.gen(function* () {
      const current = yield* storagePolicy.current;
      if (!current.automaticCleanupEnabled) return null;
      const hours = current.idleTerminalStopHours;
      if (hours === null) return null;
      if (!Number.isFinite(hours) || hours <= 0) {
        yield* Effect.logWarning("idle terminal reaper disabled by invalid timeout setting", {
          idleTerminalStopHours: hours,
        });
        return null;
      }
      return hours * HOUR_MS;
    });

    const getThread = (threadId: string) =>
      projection.getThreadShellById(ThreadId.make(threadId)).pipe(
        Effect.map(
          Option.match({
            onNone: () => ({ kind: "missing" as const }),
            onSome: (thread) => ({ kind: "active" as const, thread }),
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("idle terminal reaper could not read thread state", {
            threadId,
            error,
          }).pipe(Effect.as({ kind: "unavailable" as const })),
        ),
      );

    const threadHasOpenPreview = (threadId: string) =>
      previews.list({ threadId: ThreadId.make(threadId) }).pipe(
        Effect.map((result) => result.sessions.length > 0),
        Effect.catchCause((cause) =>
          Effect.logWarning("idle terminal reaper could not verify preview usage", {
            threadId,
            cause,
          }).pipe(Effect.as(true)),
        ),
      );

    const appendStoppedActivity = (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly title: string;
      readonly hours: number | null;
      readonly reason: "idle" | "archived-or-deleted";
    }) => {
      const createdAt = new Date().toISOString();
      const roundedHours = input.hours === null ? null : Number(input.hours.toFixed(2));
      const summary =
        input.reason === "idle"
          ? `Stopped idle terminal ${input.title} after ${roundedHours} h of inactivity`
          : `Stopped orphaned terminal ${input.title} because its thread is archived or deleted`;
      return orchestration
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:idle-terminal-reaper:${crypto.randomUUID()}`),
          threadId: ThreadId.make(input.threadId),
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: "info",
            kind: "terminal.stopped-idle",
            summary,
            payload: {
              terminalId: input.terminalId,
              inactivityHours: roundedHours,
              reason: input.reason,
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("idle terminal reaper could not append activity", {
              threadId: ThreadId.make(input.threadId),
              terminalId: input.terminalId,
              cause,
            }),
          ),
        );
    };

    const stopPriorProcesses = (nowMs: number, thresholdMs: number | null) =>
      Effect.gen(function* () {
        const records = yield* terminals.listOwnedProcessRecords();
        let cleanedCount = 0;
        const recordStart = records.length ? priorProcessCursor % records.length : 0;
        const priorBatch = [
          ...records.slice(recordStart, recordStart + MAX_OLD_PROCESSES_PER_SWEEP),
          ...records.slice(
            0,
            Math.max(0, recordStart + MAX_OLD_PROCESSES_PER_SWEEP - records.length),
          ),
        ];
        priorProcessCursor = records.length
          ? (recordStart + priorBatch.length) % records.length
          : 0;
        for (const record of priorBatch) {
          const threadState = yield* getThread(record.threadId);
          if (threadState.kind === "unavailable") continue;
          const archivedOrDeleted = threadState.kind === "missing";
          const lastOutputAtMs = Date.parse(record.lastOutputAt);
          const idleByThread =
            threadState.kind === "active" &&
            thresholdMs !== null &&
            isThreadIdleForTerminalReaper(threadState.thread, nowMs, thresholdMs) &&
            Number.isFinite(lastOutputAtMs) &&
            lastOutputAtMs <= nowMs - thresholdMs;
          if (!archivedOrDeleted && !idleByThread) continue;
          if (yield* threadHasOpenPreview(record.threadId)) continue;

          const result = yield* terminals.terminateOwnedProcessRecord(record);
          if (result !== "terminated") continue;
          cleanedCount += 1;
          yield* Effect.logInfo("idle terminal reaper stopped a prior process group", {
            threadId: record.threadId,
            terminalId: record.terminalId,
            title: record.title,
            pid: record.pid,
            reason: archivedOrDeleted ? "thread_archived_or_deleted" : "idle",
          });
          if (!archivedOrDeleted && idleByThread && thresholdMs !== null) {
            yield* appendStoppedActivity({
              threadId: record.threadId,
              terminalId: record.terminalId,
              title: record.title,
              hours: thresholdMs / HOUR_MS,
              reason: "idle",
            });
          } else if (archivedOrDeleted) {
            yield* appendStoppedActivity({
              threadId: record.threadId,
              terminalId: record.terminalId,
              title: record.title,
              hours: null,
              reason: "archived-or-deleted",
            });
          }
        }
        if (cleanedCount > 0) {
          yield* Effect.logInfo("idle terminal reaper prior-process sweep complete", {
            cleanedCount,
          });
        }
      });

    const sweep = Effect.gen(function* () {
      const thresholdMs = yield* readThresholdMs;
      const nowMs = Date.now();
      yield* stopPriorProcesses(nowMs, thresholdMs);
      if (thresholdMs === null) return;

      const candidates = yield* terminals.listReaperSessions();
      const terminalStart = candidates.length ? terminalCursor % candidates.length : 0;
      const terminalBatch = [
        ...candidates.slice(terminalStart, terminalStart + MAX_TERMINALS_PER_SWEEP),
        ...candidates.slice(
          0,
          Math.max(0, terminalStart + MAX_TERMINALS_PER_SWEEP - candidates.length),
        ),
      ];
      terminalCursor = candidates.length
        ? (terminalStart + terminalBatch.length) % candidates.length
        : 0;
      let stoppedCount = 0;
      for (const terminal of terminalBatch) {
        const threadState = yield* getThread(terminal.threadId);
        if (
          threadState.kind !== "active" ||
          !isThreadIdleForTerminalReaper(threadState.thread, nowMs, thresholdMs) ||
          (yield* threadHasOpenPreview(terminal.threadId))
        ) {
          continue;
        }
        const lastOutputAtMs = Date.parse(terminal.lastOutputAt);
        if (!Number.isFinite(lastOutputAtMs) || lastOutputAtMs > nowMs - thresholdMs) continue;

        // Re-read both independent user-activity signals immediately before
        // close; closeIfIdle atomically rechecks output and attach-stream count.
        const currentThread = yield* getThread(terminal.threadId);
        if (
          currentThread.kind !== "active" ||
          !isThreadIdleForTerminalReaper(currentThread.thread, Date.now(), thresholdMs) ||
          (yield* threadHasOpenPreview(terminal.threadId))
        ) {
          continue;
        }
        const outputBefore = new Date(Date.now() - thresholdMs).toISOString();
        const closed = yield* terminals
          .closeIfIdle({
            threadId: terminal.threadId,
            terminalId: terminal.terminalId,
            outputBefore,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("idle terminal reaper could not close terminal", {
                threadId: terminal.threadId,
                terminalId: terminal.terminalId,
                error,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!closed) continue;
        stoppedCount += 1;
        yield* appendStoppedActivity({
          threadId: terminal.threadId,
          terminalId: terminal.terminalId,
          title: terminal.title,
          hours: thresholdMs / HOUR_MS,
          reason: "idle",
        });
        yield* Effect.logInfo("idle terminal reaper stopped terminal", {
          threadId: terminal.threadId,
          terminalId: terminal.terminalId,
          title: terminal.title,
          inactivityThresholdMs: thresholdMs,
          reason: "inactivity_threshold",
        });
      }
      if (stoppedCount > 0) {
        yield* Effect.logInfo("idle terminal reaper sweep complete", {
          stoppedCount,
          candidateCount: candidates.length,
        });
      }
    });

    const runSweepSafely = sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("idle terminal reaper sweep failed", { cause }),
      ),
    );

    const reconcileStartup: IdleTerminalReaperShape["reconcileStartup"] = Effect.gen(function* () {
      yield* runSweepSafely;
    });

    const start: IdleTerminalReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          runSweepSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        yield* Effect.logInfo("idle terminal reaper started", { sweepIntervalMs });
      });

    return { reconcileStartup, start } satisfies IdleTerminalReaperShape;
  });

export const makeIdleTerminalReaperLive = (options?: IdleTerminalReaperLiveOptions) =>
  Layer.effect(IdleTerminalReaper, makeIdleTerminalReaper(options));

export const IdleTerminalReaperLive = makeIdleTerminalReaperLive();
