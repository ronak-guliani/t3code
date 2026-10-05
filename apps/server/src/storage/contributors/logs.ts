/** Provider logs follow the effective retention policy; other logs are measured only. */
import type { StorageCleanupItemResult } from "@t3tools/contracts";
import { Effect, Exit } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  executeProviderLogCleanup,
  planProviderLogCleanup,
  type PlannedProviderLogRemoval,
} from "../../provider/Layers/ProviderLogRetention.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { measureDirectory } from "../measureDirectory.ts";
import type { StorageCleanupContributor, StoragePlanEntry } from "../StorageCleanup.ts";

const REASON_DESCRIPTIONS: Record<PlannedProviderLogRemoval["reason"], string> = {
  deletedThreads: "Provider logs of deleted chats",
  unknownThreads: "Provider logs of chats this server does not know",
  age: "Provider logs older than the retention window",
  sizeCap: "Oldest provider logs over the total size cap",
};

export const makeLogStorageContributor = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const runtimeSnapshot = Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    const sessions = yield* Effect.exit(providerService.listSessions());
    // Without the live-session list a live head could look idle: plan nothing.
    if (Exit.isFailure(sessions)) return null;
    return {
      threads: readModel.threads.map((thread) => ({ id: thread.id, deletedAt: thread.deletedAt })),
      liveThreadIds: new Set<string>(sessions.value.map((session) => session.threadId)),
    };
  });

  const measure: StorageCleanupContributor["measure"] = ({ signal, report }) =>
    Effect.gen(function* () {
      const provider = yield* Effect.promise(() =>
        measureDirectory(config.providerLogsDir, { signal }),
      );
      yield* report({
        category: "providerLogs",
        status: "complete",
        bytes: provider.bytes,
        items: provider.files,
      });
      const all = yield* Effect.promise(() => measureDirectory(config.logsDir, { signal }));
      yield* report({
        category: "otherLogs",
        status: "complete",
        bytes: Math.max(0, all.bytes - provider.bytes),
        items: Math.max(0, all.files - provider.files),
      });
    });

  const plan: StorageCleanupContributor["plan"] = (policy) =>
    Effect.gen(function* () {
      const runtime = yield* runtimeSnapshot;
      if (runtime === null) return [];
      const logPlan = yield* Effect.promise(() =>
        planProviderLogCleanup({
          providerLogsDir: config.providerLogsDir,
          threads: runtime.threads,
          liveThreadIds: runtime.liveThreadIds,
          retentionDays: policy.providerLogRetentionDays,
          maxTotalMb: policy.providerLogMaxTotalMb,
        }),
      );
      const groups = new Map<PlannedProviderLogRemoval["reason"], PlannedProviderLogRemoval[]>();
      for (const removal of logPlan.removals) {
        groups.set(removal.reason, [...(groups.get(removal.reason) ?? []), removal]);
      }
      return [...groups].map(
        ([reason, removals]): StoragePlanEntry<ReadonlyArray<PlannedProviderLogRemoval>> => ({
          item: {
            id: `provider-logs:${reason}`,
            category: "providerLogs",
            description:
              reason === "age" && policy.providerLogRetentionDays !== null
                ? `Provider logs older than ${policy.providerLogRetentionDays} days (${removals.length} files)`
                : `${REASON_DESCRIPTIONS[reason]} (${removals.length} files)`,
            target: config.providerLogsDir,
            estimatedBytes: removals.reduce((sum, removal) => sum + removal.size, 0),
            defaultSelected: true,
            needsManualReview: false,
          },
          payload: removals,
        }),
      );
    });

  const execute: StorageCleanupContributor["execute"] = (entries, policy) =>
    Effect.gen(function* () {
      const runtime = yield* runtimeSnapshot;
      if (runtime === null) {
        return entries.map(
          (entry): StorageCleanupItemResult => ({
            itemId: entry.item.id,
            category: entry.item.category,
            description: entry.item.description,
            status: "skipped",
            bytesFreed: 0,
            reason: "live provider sessions could not be checked",
          }),
        );
      }
      return yield* Effect.forEach(entries, (entry) =>
        Effect.promise(() =>
          executeProviderLogCleanup({
            removals: entry.payload as ReadonlyArray<PlannedProviderLogRemoval>,
            threads: runtime.threads,
            liveThreadIds: runtime.liveThreadIds,
            retentionDays: policy.providerLogRetentionDays,
          }),
        ).pipe(
          Effect.map((outcome): StorageCleanupItemResult => {
            const removed = Object.values(outcome.removed);
            const files = removed.reduce((sum, value) => sum + value.files, 0);
            const bytesFreed = removed.reduce((sum, value) => sum + value.bytes, 0);
            const notes = [
              outcome.skipped.length > 0 ? `${outcome.skipped.length} kept (now live or recent)` : null,
              outcome.failedFiles > 0 ? `${outcome.failedFiles} could not be removed` : null,
            ].filter((note) => note !== null);
            return {
              itemId: entry.item.id,
              category: entry.item.category,
              description: entry.item.description,
              status: files > 0 ? "removed" : outcome.failedFiles > 0 ? "failed" : "skipped",
              bytesFreed,
              reason: [`${files} files removed`, ...notes].join("; "),
            };
          }),
        ),
      );
    });

  return {
    id: "logs",
    categories: ["providerLogs", "otherLogs"],
    measure,
    plan,
    execute,
  } satisfies StorageCleanupContributor;
});
