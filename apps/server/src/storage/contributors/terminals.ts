/**
 * Running terminals and leftover owned terminal processes (#686). A reset
 * ignores the inactivity threshold but keeps every other reaper rule: the chat
 * is not busy or pinned, no preview tab is open, no viewer is attached
 * (`closeIfIdle` re-checks atomically), and old processes are terminated only
 * after `terminateOwnedProcessRecord` re-verifies their recorded identity.
 */
import {
  ThreadId,
  type StorageCleanupItemResult,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { isThreadBusyForTerminalReaper } from "../../terminal/Layers/IdleTerminalReaper.ts";
import {
  type OwnedTerminalProcessRecord,
  TerminalManager,
} from "../../terminal/Services/Manager.ts";
import type { StorageCleanupContributor, StoragePlanEntry } from "../StorageCleanup.ts";

type TerminalPayload =
  | { readonly kind: "session"; readonly threadId: string; readonly terminalId: string }
  | { readonly kind: "process"; readonly record: OwnedTerminalProcessRecord };

export const makeTerminalStorageContributor = Effect.gen(function* () {
  const terminals = yield* TerminalManager;
  const snapshots = yield* ProjectionSnapshotQuery;
  const previews = yield* PreviewManager;

  const threadShell = (threadId: string) =>
    snapshots.getThreadShellById(ThreadId.make(threadId)).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed((): OrchestrationThreadShell | null | undefined => undefined),
    );
  const hasOpenPreview = (threadId: string) =>
    previews.list({ threadId: ThreadId.make(threadId) }).pipe(
      Effect.map((result) => result.sessions.length > 0),
      // Unknown preview state keeps the terminal.
      Effect.catchCause(() => Effect.succeed(true)),
    );

  /** Null when the chat's terminals may be stopped now (age ignored). */
  const sessionBlocker = (threadId: string) =>
    Effect.gen(function* () {
      const shell = yield* threadShell(threadId);
      if (shell === undefined) return "chat state could not be read";
      if (shell === null) return "chat is archived or deleted";
      if (isThreadBusyForTerminalReaper(shell)) return "chat is busy or pinned";
      if (yield* hasOpenPreview(threadId)) return "a preview tab is open";
      return null;
    });

  const processBlocker = (record: OwnedTerminalProcessRecord) =>
    Effect.gen(function* () {
      const shell = yield* threadShell(record.threadId);
      if (shell === undefined) return "chat state could not be read";
      if (shell !== null && isThreadBusyForTerminalReaper(shell)) return "chat is busy or pinned";
      if (yield* hasOpenPreview(record.threadId)) return "a preview tab is open";
      return null;
    });

  const measure: StorageCleanupContributor["measure"] = ({ report }) =>
    Effect.gen(function* () {
      const sessions = yield* terminals.listReaperSessions();
      const leftovers = yield* terminals.listOwnedProcessRecords();
      yield* report({
        category: "terminals",
        status: "complete",
        bytes: 0,
        items: sessions.length + leftovers.length,
        detail: `${sessions.length} running, ${leftovers.length} left from earlier runs`,
      });
    });

  const plan: StorageCleanupContributor["plan"] = (_policy, mode) =>
    Effect.gen(function* () {
      // Automatic stopping stays in IdleTerminalReaper, behind the same policy.
      if (mode !== "reset") return [];
      const entries: Array<StoragePlanEntry<TerminalPayload>> = [];
      for (const session of yield* terminals.listReaperSessions()) {
        if (session.attachedStreams > 0) continue;
        if ((yield* sessionBlocker(session.threadId)) !== null) continue;
        const shell = yield* threadShell(session.threadId);
        entries.push({
          item: {
            id: `terminal:${session.threadId}:${session.terminalId}`,
            category: "terminals",
            description: `Stop ${session.title} in chat "${shell?.title ?? session.threadId}"`,
            target: `${session.threadId}/${session.terminalId}`,
            estimatedBytes: 0,
            defaultSelected: true,
            needsManualReview: false,
          },
          payload: { kind: "session", threadId: session.threadId, terminalId: session.terminalId },
        });
      }
      for (const record of yield* terminals.listOwnedProcessRecords()) {
        if ((yield* processBlocker(record)) !== null) continue;
        entries.push({
          item: {
            id: `terminal-process:${record.threadId}:${record.terminalId}:${record.pid}`,
            category: "terminals",
            description: `Stop ${record.title} left running by an earlier server (pid ${record.pid})`,
            target: `pid ${record.pid}`,
            estimatedBytes: 0,
            defaultSelected: true,
            needsManualReview: false,
          },
          payload: { kind: "process", record },
        });
      }
      return entries;
    });

  const executeOne = (entry: StoragePlanEntry) =>
    Effect.gen(function* () {
      const payload = entry.payload as TerminalPayload;
      const result = (
        status: StorageCleanupItemResult["status"],
        reason: string,
      ): StorageCleanupItemResult => ({
        itemId: entry.item.id,
        category: entry.item.category,
        description: entry.item.description,
        status,
        bytesFreed: 0,
        reason,
      });
      if (payload.kind === "process") {
        const blocker = yield* processBlocker(payload.record);
        if (blocker !== null) return result("skipped", blocker);
        const outcome = yield* terminals.terminateOwnedProcessRecord(payload.record);
        return outcome === "terminated"
          ? result("removed", "stopped a verified leftover process group")
          : result(
              "skipped",
              outcome === "missing" ? "already stopped" : "process identity could not be verified",
            );
      }
      const blocker = yield* sessionBlocker(payload.threadId);
      if (blocker !== null) return result("skipped", blocker);
      const closed = yield* terminals.closeIfIdle({
        threadId: payload.threadId,
        terminalId: payload.terminalId,
        // Age is ignored by a reset; the attach-stream check still applies.
        outputBefore: new Date(Date.now() + 1_000).toISOString(),
      });
      return closed
        ? result("removed", "stopped idle terminal")
        : result("skipped", "a terminal viewer is attached or it already stopped");
    });

  return {
    id: "terminals",
    categories: ["terminals"],
    measure,
    plan,
    execute: (entries) => Effect.forEach(entries, executeOne, { concurrency: 1 }),
  } satisfies StorageCleanupContributor;
});
