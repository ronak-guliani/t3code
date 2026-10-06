/**
 * One storage service over per-category contributors: background usage
 * measurement, "Clean up now" plans, and the automatic sweep.
 */
import type {
  StorageCategory,
  StorageCategoryUsage,
  StorageCleanupItem,
  StorageCleanupItemResult,
  StorageCleanupPlan,
  StorageCleanupProgress,
  StorageCleanupResult,
  StorageExecuteCleanupInput,
  StorageGetUsageInput,
  StorageUsageSnapshot,
} from "@t3tools/contracts";
import { StorageCleanupError } from "@t3tools/contracts";
import { Cause, Context, Effect, Fiber, Ref, Semaphore } from "effect";

import type { EffectiveStorageCleanupPolicy } from "./StorageCleanupPolicy.ts";
import { StorageCleanupPolicy } from "./StorageCleanupPolicy.ts";

export type StorageCleanupMode = "automatic" | "reset";

export interface StoragePlanEntry<Payload = unknown> {
  readonly item: StorageCleanupItem;
  /** Server-only data the contributor needs to re-check and execute the item. */
  readonly payload: Payload;
}

export interface StorageMeasureContext {
  readonly signal: AbortSignal;
  /** Publish (partial) usage for one of the contributor's categories. */
  readonly report: (usage: StorageCategoryUsage) => Effect.Effect<void>;
  readonly reportManualReview: (items: ReadonlyArray<StorageCleanupItem>) => Effect.Effect<void>;
}

export interface StorageCleanupContributor {
  readonly id: string;
  readonly categories: ReadonlyArray<StorageCategory>;
  readonly measure: (context: StorageMeasureContext) => Effect.Effect<void, unknown>;
  readonly plan: (
    policy: EffectiveStorageCleanupPolicy,
    mode: StorageCleanupMode,
  ) => Effect.Effect<ReadonlyArray<StoragePlanEntry>, unknown>;
  /** Re-check every item's safety now; skip, never force, items that became unsafe. */
  readonly execute: (
    entries: ReadonlyArray<StoragePlanEntry>,
    policy: EffectiveStorageCleanupPolicy,
  ) => Effect.Effect<ReadonlyArray<StorageCleanupItemResult>, unknown>;
}

export interface StorageCleanupShape {
  readonly getUsage: (input: StorageGetUsageInput) => Effect.Effect<StorageUsageSnapshot>;
  readonly previewCleanup: () => Effect.Effect<StorageCleanupPlan, StorageCleanupError>;
  readonly executeCleanup: (
    input: StorageExecuteCleanupInput,
  ) => Effect.Effect<StorageCleanupResult, StorageCleanupError>;
  /** Plan and execute every contributor's automatic items once. */
  readonly runAutomaticSweep: (policy: EffectiveStorageCleanupPolicy) => Effect.Effect<void>;
  /** Automatic VACUUM, run during startup before clients are served. */
  readonly runStartupVacuum: Effect.Effect<void>;
}

export class StorageCleanup extends Context.Service<StorageCleanup, StorageCleanupShape>()(
  "t3/storage/StorageCleanup",
) {}

export const USAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_PLANS = 8;

interface StoredPlan {
  readonly plan: StorageCleanupPlan;
  readonly entries: ReadonlyMap<string, { contributor: string; entry: StoragePlanEntry }>;
  readonly expiresAtMs: number;
}

export const makeStorageCleanup = (
  contributors: ReadonlyArray<StorageCleanupContributor>,
  runStartupVacuum: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const policyService = yield* StorageCleanupPolicy;
    const scope = yield* Effect.scope;
    const categoryOrder = contributors.flatMap((contributor) => contributor.categories);
    const emptyUsage = (category: StorageCategory): StorageCategoryUsage => ({
      category,
      status: "pending",
      bytes: 0,
      items: 0,
    });
    const usage = yield* Ref.make<{
      readonly status: StorageUsageSnapshot["status"];
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly categories: ReadonlyMap<StorageCategory, StorageCategoryUsage>;
      readonly manualReview: ReadonlyMap<string, ReadonlyArray<StorageCleanupItem>>;
    }>({
      status: "idle",
      startedAt: null,
      completedAt: null,
      categories: new Map(categoryOrder.map((category) => [category, emptyUsage(category)])),
      manualReview: new Map(),
    });
    const measurement = yield* Ref.make<Fiber.Fiber<void> | null>(null);
    const plans = new Map<string, StoredPlan>();
    const cleanupProgress = yield* Ref.make<StorageCleanupProgress | null>(null);
    // Executions (manual or automatic) never interleave: each re-checks safety
    // against state the other may be changing.
    const executionLock = yield* Semaphore.make(1);

    const markMeasuring = Ref.update(usage, (current) => ({
      ...current,
      status: "measuring" as const,
      startedAt: new Date().toISOString(),
      completedAt: null,
      categories: new Map(
        [...current.categories].map(([category, value]) => [
          category,
          { ...value, status: "measuring" as const },
        ]),
      ),
    }));

    const measureAll = Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.forEach(
        contributors,
        (contributor) =>
          contributor
            .measure({
              signal: controller.signal,
              report: (value) =>
                Ref.update(usage, (current) => ({
                  ...current,
                  categories: new Map(current.categories).set(value.category, value),
                })),
              reportManualReview: (items) =>
                Ref.update(usage, (current) => ({
                  ...current,
                  manualReview: new Map(current.manualReview).set(contributor.id, items),
                })),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("storage.usage: contributor measurement failed", {
                      contributor: contributor.id,
                      cause: Cause.pretty(cause),
                    }).pipe(
                      Effect.andThen(
                        Ref.update(usage, (current) => {
                          const categories = new Map(current.categories);
                          for (const category of contributor.categories) {
                            const value = categories.get(category) ?? emptyUsage(category);
                            if (value.status !== "complete") {
                              categories.set(category, { ...value, status: "failed" });
                            }
                          }
                          return { ...current, categories };
                        }),
                      ),
                    ),
              ),
            ),
        { concurrency: 3, discard: true },
      ).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())));
      yield* Ref.update(usage, (current) => ({
        ...current,
        status: "complete" as const,
        completedAt: new Date().toISOString(),
      }));
    }).pipe(
      Effect.onInterrupt(() =>
        Ref.update(usage, (current) => ({
          ...current,
          status: "cancelled" as const,
          completedAt: new Date().toISOString(),
        })),
      ),
    );

    const startMeasurement = Effect.gen(function* () {
      const running = yield* Ref.get(measurement);
      if (running !== null) return running;
      // Before forking: the caller's snapshot must already say "measuring".
      yield* markMeasuring;
      const fiber = yield* measureAll.pipe(
        Effect.ensuring(Ref.set(measurement, null)),
        Effect.forkIn(scope),
      );
      yield* Ref.set(measurement, fiber);
      return fiber;
    }).pipe(Effect.uninterruptible);

    const isUsageFresh = Effect.map(
      Ref.get(usage),
      (current) =>
        current.status === "complete" &&
        current.completedAt !== null &&
        Date.now() - Date.parse(current.completedAt) < USAGE_CACHE_TTL_MS,
    );

    // A cancelled measurement stays cancelled until the user asks again.
    const needsAutomaticMeasurement = Effect.map(
      Ref.get(usage),
      (current) =>
        current.status === "idle" ||
        (current.status === "complete" &&
          (current.completedAt === null ||
            Date.now() - Date.parse(current.completedAt) >= USAGE_CACHE_TTL_MS)),
    );

    const snapshot = Effect.gen(function* () {
      const current = yield* Ref.get(usage);
      const policy = yield* policyService.current;
      return {
        status: current.status,
        startedAt: current.startedAt,
        completedAt: current.completedAt,
        categories: categoryOrder.map(
          (category) => current.categories.get(category) ?? emptyUsage(category),
        ),
        lowDisk: policy.lowDisk,
        automaticCleanupEnabled: policy.automaticCleanupEnabled,
        manualReview: [...current.manualReview.values()].flat(),
        cleanup: yield* Ref.get(cleanupProgress),
      } satisfies StorageUsageSnapshot;
    });

    const getUsage: StorageCleanupShape["getUsage"] = (input) =>
      Effect.gen(function* () {
        if (input.cancel === true) {
          const running = yield* Ref.get(measurement);
          if (running !== null) yield* Fiber.interrupt(running);
        } else if (input.refresh === true || (yield* needsAutomaticMeasurement)) {
          yield* startMeasurement;
        }
        return yield* snapshot;
      });

    const collectPlan = (policy: EffectiveStorageCleanupPolicy, mode: StorageCleanupMode) =>
      Effect.forEach(
        contributors,
        (contributor) =>
          contributor.plan(policy, mode).pipe(
            Effect.map((entries) => entries.map((entry) => ({ contributor, entry }))),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("storage.cleanup: contributor plan failed", {
                    contributor: contributor.id,
                    mode,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as([])),
            ),
          ),
        { concurrency: 2 },
      ).pipe(Effect.map((groups) => groups.flat()));

    const previewCleanup: StorageCleanupShape["previewCleanup"] = () =>
      Effect.gen(function* () {
        // Estimates come from the measurement cache: refresh it first if stale.
        if (!(yield* isUsageFresh)) {
          yield* Fiber.join(yield* startMeasurement);
        }
        const policy = yield* policyService.current;
        const planned = yield* collectPlan(policy, "reset");
        const nowMs = Date.now();
        for (const [planId, stored] of plans) {
          if (stored.expiresAtMs <= nowMs) plans.delete(planId);
        }
        while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
        const items = planned.map(({ entry }) => entry.item);
        const totals = new Map<StorageCategory, { items: number; estimatedBytes: number }>();
        for (const item of items) {
          const total = totals.get(item.category) ?? { items: 0, estimatedBytes: 0 };
          totals.set(item.category, {
            items: total.items + 1,
            estimatedBytes: total.estimatedBytes + item.estimatedBytes,
          });
        }
        const plan: StorageCleanupPlan = {
          planId: crypto.randomUUID(),
          createdAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + PLAN_TTL_MS).toISOString(),
          items,
          totals: [...totals].map(([category, total]) => ({ category, ...total })),
          totalEstimatedBytes: items.reduce((sum, item) => sum + item.estimatedBytes, 0),
          lowDisk: policy.lowDisk,
        };
        plans.set(plan.planId, {
          plan,
          expiresAtMs: nowMs + PLAN_TTL_MS,
          entries: new Map(
            planned.map(({ contributor, entry }) => [
              entry.item.id,
              { contributor: contributor.id, entry },
            ]),
          ),
        });
        yield* Effect.logInfo("storage.cleanup: previewed reset plan", {
          planId: plan.planId,
          items: items.length,
          totals: plan.totals,
        });
        return plan;
      });

    const executeEntries = (
      selected: ReadonlyArray<{ contributor: string; entry: StoragePlanEntry }>,
      policy: EffectiveStorageCleanupPolicy,
      onProgress: (results: ReadonlyArray<StorageCleanupItemResult>) => Effect.Effect<void>,
    ) =>
      Effect.forEach(
        contributors,
        (contributor) => {
          const entries = selected
            .filter((candidate) => candidate.contributor === contributor.id)
            .map((candidate) => candidate.entry);
          if (entries.length === 0) return Effect.succeed([]);
          return contributor.execute(entries, policy).pipe(
            Effect.tap(onProgress),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.succeed(
                    entries.map(
                      (entry): StorageCleanupItemResult => ({
                        itemId: entry.item.id,
                        category: entry.item.category,
                        description: entry.item.description,
                        status: "failed",
                        bytesFreed: 0,
                        reason: Cause.pretty(cause).split("\n")[0] ?? "cleanup failed",
                      }),
                    ),
                  ),
            ),
          );
        },
        // Sequential: contributors share the disk and some take checkout locks.
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat()));

    const logResults = (
      trigger: "manual" | "automatic",
      results: ReadonlyArray<StorageCleanupItemResult>,
    ) =>
      Effect.forEach(
        results,
        (result) =>
          Effect.logInfo("storage.cleanup: item " + result.status, {
            trigger,
            itemId: result.itemId,
            category: result.category,
            description: result.description,
            bytesFreed: result.bytesFreed,
            reason: result.reason,
          }),
        { discard: true },
      );

    const executeCleanup: StorageCleanupShape["executeCleanup"] = (input) =>
      Effect.gen(function* () {
        const stored = plans.get(input.planId);
        if (stored === undefined || stored.expiresAtMs <= Date.now()) {
          return yield* new StorageCleanupError({
            message: "This cleanup plan has expired. Preview the cleanup again.",
          });
        }
        const selected = input.itemIds.map((itemId) => stored.entries.get(itemId));
        if (selected.some((entry) => entry === undefined)) {
          return yield* new StorageCleanupError({
            message: "Only items from the previewed plan can be cleaned up.",
          });
        }
        // A plan runs at most once; a second execute must re-preview.
        plans.delete(input.planId);
        const entries = selected as ReadonlyArray<{
          contributor: string;
          entry: StoragePlanEntry;
        }>;
        return yield* executionLock
          .withPermits(1)(
            Effect.gen(function* () {
              const startedAt = new Date().toISOString();
              yield* Ref.set(cleanupProgress, {
                planId: input.planId,
                status: "running",
                completedItems: 0,
                totalItems: entries.length,
                bytesFreed: 0,
                result: null,
              });
              const policy = yield* policyService.current;
              const results = yield* executeEntries(entries, policy, (done) =>
                Ref.update(cleanupProgress, (progress) =>
                  progress === null
                    ? progress
                    : {
                        ...progress,
                        completedItems: progress.completedItems + done.length,
                        bytesFreed:
                          progress.bytesFreed + done.reduce((sum, r) => sum + r.bytesFreed, 0),
                      },
                ),
              );
              yield* logResults("manual", results);
              const bytesFreed = results.reduce((sum, result) => sum + result.bytesFreed, 0);
              const result = {
                planId: input.planId,
                startedAt,
                completedAt: new Date().toISOString(),
                results,
                bytesFreed,
              } satisfies StorageCleanupResult;
              yield* Ref.update(cleanupProgress, (progress) =>
                progress === null
                  ? progress
                  : { ...progress, status: "complete" as const, bytesFreed, result },
              );
              yield* Effect.logInfo("storage.cleanup: reset complete", {
                planId: input.planId,
                removed: results.filter((result) => result.status === "removed").length,
                skipped: results.filter((result) => result.status === "skipped").length,
                failed: results.filter((result) => result.status === "failed").length,
                bytesFreed,
              });
              // Usage changed; the next read measures again.
              yield* Ref.update(usage, (current) => ({ ...current, completedAt: null }));
              return result;
            }),
          )
          .pipe(
            // A dropped client connection must not abandon a half-run reset.
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
          );
      });

    const runAutomaticSweep: StorageCleanupShape["runAutomaticSweep"] = (policy) =>
      executionLock.withPermits(1)(
        Effect.gen(function* () {
          const planned = yield* collectPlan(policy, "automatic");
          if (planned.length === 0) return;
          const results = yield* executeEntries(
            planned.map(({ contributor, entry }) => ({ contributor: contributor.id, entry })),
            policy,
            () => Effect.void,
          );
          yield* logResults("automatic", results);
        }),
      );

    return {
      getUsage,
      previewCleanup,
      executeCleanup,
      runAutomaticSweep,
      runStartupVacuum,
    } satisfies StorageCleanupShape;
  });
