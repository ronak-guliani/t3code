import {
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { activityChangesShellSummary } from "./projection/ProjectionImpact.ts";

type ShellStreamProjectionQuery = Pick<
  ProjectionSnapshotQueryShape,
  "getProjectShellById" | "getThreadShellById"
>;

export function filterActiveShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
): OrchestrationShellSnapshot {
  const threads = snapshot.threads.filter((thread) => thread.archivedAt === null);
  return threads.length === snapshot.threads.length ? snapshot : { ...snapshot, threads };
}

export function filterArchivedShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
): OrchestrationShellSnapshot {
  const threads = snapshot.threads.filter((thread) => thread.archivedAt !== null);
  const projectIds = new Set(threads.map((thread) => thread.projectId));
  const projects = snapshot.projects.filter((project) => projectIds.has(project.id));
  return { ...snapshot, projects, threads };
}

/**
 * Whether an appended activity can change what the shell row renders.
 * Streaming turns emit dozens of activities per turn (tool updates, text
 * deltas) that touch no shell field; re-reading the shell (5 SELECTs plus a
 * WS upsert) for each one costs the single SQLite connection and spams every
 * subscriber with identical rows. Uses the reconciler's predicate so the
 * write and read paths agree, plus task boundaries: background-agent runs
 * render from live activity rows rather than the thread row.
 */
function activityChangesShellStreamSummary(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return true;
  }
  return activityChangesShellSummary(activity);
}

export function toShellStreamEvent(
  projectionSnapshotQuery: ShellStreamProjectionQuery,
  event: OrchestrationEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
      return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
        Effect.map((project) =>
          Option.map(project, (nextProject) => ({
            kind: "project-upserted" as const,
            sequence: event.sequence,
            project: nextProject,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    case "project.deleted":
      return Effect.succeed(
        Option.some({
          kind: "project-removed" as const,
          sequence: event.sequence,
          projectId: event.payload.projectId,
        }),
      );
    case "thread.deleted":
    case "thread.archived":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    default:
      if (event.aggregateKind !== "thread") {
        return Effect.succeed(Option.none());
      }
      if (
        event.type === "thread.activity-appended" &&
        !activityChangesShellStreamSummary(event.payload.activity)
      ) {
        return Effect.succeed(Option.none());
      }
      return projectionSnapshotQuery.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
        Effect.map((thread) =>
          Option.map(thread, (nextThread) => ({
            kind: "thread-upserted" as const,
            sequence: event.sequence,
            thread: nextThread,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
  }
}
