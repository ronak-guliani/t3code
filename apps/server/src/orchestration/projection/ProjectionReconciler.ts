import { ApprovalRequestId, type ThreadId } from "@t3tools/contracts";
import { Context, Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect";
import type * as PlatformError from "effect/PlatformError";

import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionReconciliationJobRepository } from "../../persistence/Services/ProjectionReconciliationJobs.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import type { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import type { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function staleUserInputFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request"))
  );
}

function derivePendingUserInputCount(activities: ReadonlyArray<ProjectionThreadActivity>): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      staleUserInputFailure(detail)
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );
  const latestForTurn =
    input.latestTurnId === null
      ? null
      : (sorted.findLast((plan) => plan.turnId === input.latestTurnId) ?? null);
  const latestPlan = latestForTurn ?? sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

interface ProjectionReconcilerShape {
  readonly drain: Effect.Effect<void, ProjectionRepositoryError | PlatformError.PlatformError>;
}

export class ProjectionReconciler extends Context.Service<
  ProjectionReconciler,
  ProjectionReconcilerShape
>()("t3/orchestration/projection/ProjectionReconciler") {}

const makeProjectionReconciler = Effect.gen(function* () {
  const jobs = yield* ProjectionReconciliationJobRepository;
  const threads = yield* ProjectionThreadRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const proposedPlans = yield* ProjectionThreadProposedPlanRepository;
  const activities = yield* ProjectionThreadActivityRepository;
  const pendingApprovals = yield* ProjectionPendingApprovalRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const drainLock = yield* Semaphore.make(1);

  const refreshShellSummary = Effect.fn("refreshProjectionThreadShellSummary")(function* (
    threadId: ThreadId,
  ) {
    const existing = yield* threads.getById({ threadId });
    if (Option.isNone(existing)) {
      return;
    }
    const [threadMessages, threadPlans, threadActivities, threadApprovals] = yield* Effect.all(
      [
        messages.listByThreadId({ threadId }),
        proposedPlans.listByThreadId({ threadId }),
        activities.listByThreadId({ threadId }),
        pendingApprovals.listByThreadId({ threadId }),
      ],
      { concurrency: "unbounded" },
    );
    const latestUserMessageAt =
      threadMessages
        .filter((message) => message.role === "user")
        .map((message) => message.createdAt)
        .toSorted()
        .at(-1) ?? null;

    yield* threads.upsert({
      ...existing.value,
      latestUserMessageAt,
      pendingApprovalCount: threadApprovals.filter((approval) => approval.status === "pending")
        .length,
      pendingUserInputCount: derivePendingUserInputCount(threadActivities),
      hasActionableProposedPlan: deriveHasActionableProposedPlan({
        latestTurnId: existing.value.latestTurnId,
        proposedPlans: threadPlans,
      })
        ? 1
        : 0,
    });
  });

  const readAttachmentEntries = fileSystem
    .readDirectory(serverConfig.attachmentsDir, {
      recursive: false,
    })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed([] as Array<string>) : Effect.fail(error),
      ),
    );

  const reconcileAttachments = Effect.fn("reconcileProjectionThreadAttachments")(function* (
    threadId: ThreadId,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      return yield* Effect.logWarning("skipping attachment reconciliation for unsafe thread", {
        threadId,
      });
    }
    const thread = yield* threads.getById({ threadId });
    const keptRelativePaths = new Set<string>();
    if (Option.isSome(thread) && thread.value.deletedAt === null) {
      const threadMessages = yield* messages.listByThreadId({ threadId });
      for (const message of threadMessages) {
        for (const attachment of message.attachments ?? []) {
          if (
            attachment.type === "image" &&
            parseThreadSegmentFromAttachmentId(attachment.id) === threadSegment
          ) {
            keptRelativePaths.add(attachmentRelativePath(attachment));
          }
        }
      }
    }

    const entries = yield* readAttachmentEntries;
    yield* Effect.forEach(
      entries,
      (entry) => {
        const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
        if (relativePath.length === 0 || relativePath.includes("/")) {
          return Effect.void;
        }
        const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
        if (
          !attachmentId ||
          parseThreadSegmentFromAttachmentId(attachmentId) !== threadSegment ||
          keptRelativePaths.has(relativePath)
        ) {
          return Effect.void;
        }
        return fileSystem.remove(path.join(serverConfig.attachmentsDir, relativePath), {
          force: true,
        });
      },
      { concurrency: 1, discard: true },
    );
  });

  const drain = drainLock.withPermit(
    Effect.gen(function* () {
      const pending = yield* jobs.listPending();
      if (pending.length === 0) {
        return;
      }
      const shellThreadIds = new Set(pending.flatMap((job) => job.shellThreadIds));
      const attachmentThreadIds = new Set(pending.flatMap((job) => job.attachmentThreadIds));
      yield* Effect.forEach(shellThreadIds, refreshShellSummary, {
        concurrency: 1,
        discard: true,
      });
      yield* Effect.forEach(attachmentThreadIds, reconcileAttachments, {
        concurrency: 1,
        discard: true,
      });
      yield* jobs.completeThrough({
        sequence: pending.at(-1)!.sequence,
      });
    }),
  ) satisfies Effect.Effect<void, ProjectionRepositoryError | PlatformError.PlatformError>;

  return { drain } satisfies ProjectionReconcilerShape;
});

export const ProjectionReconcilerLive = Layer.effect(
  ProjectionReconciler,
  makeProjectionReconciler,
);
