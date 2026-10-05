import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Storage usage and "Clean up now" contracts. Byte counts are apparent sizes
 * (sum of file lengths); APFS clones can make them larger than real disk use.
 */
export const StorageCategory = Schema.Literals([
  "worktrees",
  "worktreeTrash",
  "providerLogs",
  "otherLogs",
  "database",
  "databaseBackups",
  "attachments",
  "browserArtifacts",
  "terminals",
  "validationEnvironments",
]);
export type StorageCategory = typeof StorageCategory.Type;

const ByteCount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const StorageCategoryUsage = Schema.Struct({
  category: StorageCategory,
  status: Schema.Literals(["pending", "measuring", "complete", "failed"]),
  bytes: ByteCount,
  items: ByteCount,
  /** Database only: free pages that VACUUM could return to the filesystem. */
  reclaimableBytes: Schema.optional(ByteCount),
  detail: Schema.optional(Schema.String),
});
export type StorageCategoryUsage = typeof StorageCategoryUsage.Type;

export const StorageVolume = Schema.Struct({
  path: Schema.String,
  freeBytes: ByteCount,
  totalBytes: ByteCount,
  freePercent: Schema.Number,
});
export type StorageVolume = typeof StorageVolume.Type;

export const StorageLowDiskStatus = Schema.Struct({
  active: Schema.Boolean,
  thresholdPercent: Schema.Number,
  /** Lowest free percentage across measured volumes, or null when unmeasured. */
  freePercent: Schema.NullOr(Schema.Number),
  volumes: Schema.Array(StorageVolume),
});
export type StorageLowDiskStatus = typeof StorageLowDiskStatus.Type;

export const StorageCleanupItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  category: StorageCategory,
  description: Schema.String,
  target: Schema.String,
  estimatedBytes: ByteCount,
  /** Selected in the preview dialog unless the user opts out. */
  defaultSelected: Schema.Boolean,
  /** Ownership could not be proven: run only after an explicit per-item confirm. */
  needsManualReview: Schema.Boolean,
  estimatedDurationMs: Schema.optional(ByteCount),
});
export type StorageCleanupItem = typeof StorageCleanupItem.Type;

export const StorageGetUsageInput = Schema.Struct({
  /** Start a fresh measurement even when the cached one is recent. */
  refresh: Schema.optional(Schema.Boolean),
  /** Cancel an in-flight measurement, keeping partial results. */
  cancel: Schema.optional(Schema.Boolean),
});
export type StorageGetUsageInput = typeof StorageGetUsageInput.Type;

export const StorageCleanupCategoryTotal = Schema.Struct({
  category: StorageCategory,
  items: ByteCount,
  estimatedBytes: ByteCount,
});
export type StorageCleanupCategoryTotal = typeof StorageCleanupCategoryTotal.Type;

export const StorageCleanupPlan = Schema.Struct({
  planId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  items: Schema.Array(StorageCleanupItem),
  totals: Schema.Array(StorageCleanupCategoryTotal),
  totalEstimatedBytes: ByteCount,
  lowDisk: StorageLowDiskStatus,
});
export type StorageCleanupPlan = typeof StorageCleanupPlan.Type;

export const StoragePreviewCleanupInput = Schema.Struct({});
export type StoragePreviewCleanupInput = typeof StoragePreviewCleanupInput.Type;

export const StorageExecuteCleanupInput = Schema.Struct({
  planId: TrimmedNonEmptyString,
  itemIds: Schema.Array(TrimmedNonEmptyString),
});
export type StorageExecuteCleanupInput = typeof StorageExecuteCleanupInput.Type;

export const StorageCleanupItemResult = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  category: StorageCategory,
  description: Schema.String,
  status: Schema.Literals(["removed", "skipped", "failed"]),
  bytesFreed: ByteCount,
  reason: Schema.NullOr(Schema.String),
});
export type StorageCleanupItemResult = typeof StorageCleanupItemResult.Type;

export const StorageCleanupResult = Schema.Struct({
  planId: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  results: Schema.Array(StorageCleanupItemResult),
  bytesFreed: ByteCount,
});
export type StorageCleanupResult = typeof StorageCleanupResult.Type;

export const StorageCleanupProgress = Schema.Struct({
  planId: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "complete"]),
  completedItems: ByteCount,
  totalItems: ByteCount,
  bytesFreed: ByteCount,
  /** Final result, kept so a client that lost the execute response can still show it. */
  result: Schema.NullOr(StorageCleanupResult),
});
export type StorageCleanupProgress = typeof StorageCleanupProgress.Type;

export const StorageUsageSnapshot = Schema.Struct({
  status: Schema.Literals(["idle", "measuring", "complete", "cancelled"]),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  categories: Schema.Array(StorageCategoryUsage),
  lowDisk: StorageLowDiskStatus,
  automaticCleanupEnabled: Schema.Boolean,
  manualReview: Schema.Array(StorageCleanupItem),
  cleanup: Schema.NullOr(StorageCleanupProgress),
});
export type StorageUsageSnapshot = typeof StorageUsageSnapshot.Type;

export class StorageCleanupError extends Schema.TaggedErrorClass<StorageCleanupError>()(
  "StorageCleanupError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
