import { useQuery } from "@tanstack/react-query";
import type { DiffSnapshot, EnvironmentId, ThreadId, TurnDiffScope } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { buildPatchCacheKey } from "~/lib/diffRendering";
import { diffStateQueryOptions } from "~/lib/providerReactQuery";
import type { TurnDiffSummary } from "../types";

const MAX_STALE_DIFF_SNAPSHOTS = 20;

export interface DiffTurnCountRange {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}

export function resolveSessionDiffRange(input: {
  readonly summaries: ReadonlyArray<TurnDiffSummary>;
  readonly inferredCheckpointTurnCountByTurnId: Readonly<Record<string, number | undefined>>;
  readonly sessionStartCheckpointTurnCount: number | null | undefined;
}): DiffTurnCountRange | null {
  const sessionStartCheckpointTurnCount = input.sessionStartCheckpointTurnCount;
  if (typeof sessionStartCheckpointTurnCount !== "number") {
    return null;
  }

  const sessionTurnCounts = input.summaries
    .map(
      (summary) =>
        summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId],
    )
    .filter(
      (turnCount): turnCount is number =>
        typeof turnCount === "number" && turnCount > sessionStartCheckpointTurnCount,
    );

  if (sessionTurnCounts.length === 0) {
    return null;
  }

  return {
    fromTurnCount: sessionStartCheckpointTurnCount,
    toTurnCount: Math.max(...sessionTurnCounts),
  };
}

export function buildDiffCheckpointRevision(
  summaries: ReadonlyArray<TurnDiffSummary | undefined>,
): string | null {
  const parts = summaries.flatMap((summary) => {
    if (!summary) {
      return [];
    }
    return [
      [
        summary.turnId,
        summary.checkpointTurnCount ?? "missing-count",
        summary.checkpointRef ?? "missing-ref",
        summary.status ?? "unknown",
        summary.completedAt,
        summary.status === "speculative" && summary.speculativePatch
          ? buildPatchCacheKey(summary.speculativePatch, "speculative-patch")
          : "no-speculative-patch",
      ].join(":"),
    ];
  });
  return parts.length > 0 ? parts.join("|") : null;
}

export function useDiffState(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly kind: "turn" | "conversation";
  readonly scope: TurnDiffScope;
  readonly checkpointRevision: string | null;
  readonly enabled: boolean;
}) {
  const query = useQuery(
    diffStateQueryOptions({
      environmentId: input.environmentId,
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      kind: input.kind,
      scope: input.scope,
      checkpointRevision: input.checkpointRevision,
      enabled: input.enabled,
    }),
  );

  const staleSnapshotKey = useMemo(() => {
    if (!input.environmentId || !input.threadId) {
      return null;
    }
    return [
      input.environmentId,
      input.threadId,
      input.kind,
      input.scope,
      input.fromTurnCount ?? "none",
      input.toTurnCount ?? "none",
    ].join(":");
  }, [
    input.environmentId,
    input.fromTurnCount,
    input.kind,
    input.scope,
    input.threadId,
    input.toTurnCount,
  ]);

  const lastReadySnapshotByKeyRef = useRef(new Map<string, DiffSnapshot>());
  const activeDiffState = query.data;

  useEffect(() => {
    if (staleSnapshotKey && activeDiffState?._tag === "ready") {
      const snapshots = lastReadySnapshotByKeyRef.current;
      snapshots.set(staleSnapshotKey, activeDiffState.snapshot);
      if (snapshots.size > MAX_STALE_DIFF_SNAPSHOTS) {
        const oldestKey = snapshots.keys().next().value;
        if (oldestKey) {
          snapshots.delete(oldestKey);
        }
      }
    }
  }, [activeDiffState, staleSnapshotKey]);

  const staleSnapshot = staleSnapshotKey
    ? lastReadySnapshotByKeyRef.current.get(staleSnapshotKey)
    : undefined;
  const displayDiffState =
    staleSnapshot && (activeDiffState?._tag === "unavailable" || activeDiffState?._tag === "error")
      ? {
          _tag: "stale" as const,
          snapshot: staleSnapshot,
          message: activeDiffState.message,
        }
      : activeDiffState;
  const snapshot =
    displayDiffState?._tag === "ready" ||
    displayDiffState?._tag === "staged" ||
    displayDiffState?._tag === "stale"
      ? displayDiffState.snapshot
      : null;
  const message =
    displayDiffState?._tag === "unavailable" ||
    displayDiffState?._tag === "error" ||
    displayDiffState?._tag === "staged" ||
    displayDiffState?._tag === "stale"
      ? displayDiffState.message
      : null;
  const errorMessage =
    message ??
    (query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Failed to load checkpoint diff."
        : null);

  return {
    state: displayDiffState,
    snapshot,
    isLoading: query.isLoading || displayDiffState?._tag === "loading",
    errorMessage,
  };
}
