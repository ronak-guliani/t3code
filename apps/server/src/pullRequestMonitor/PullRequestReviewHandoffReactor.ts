import {
  type OrchestrationEvent,
  type ProjectId,
  type PullRequestMonitorFinding,
  type PullRequestMonitorSubmitFindingsInput,
  type ReviewResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { createHash } from "node:crypto";

/** Cursor row name for the durable handoff position; see ProjectionStateRepository. */
export const REVIEW_HANDOFF_PROJECTOR = "pullRequestReviewHandoff";

/** Transient submit failures retry; a persistently failing event is skipped until restart. */
const SUBMIT_RETRY = Schedule.exponential("1 seconds").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.jittered,
);

const SEVERITY_BY_PRIORITY = {
  critical: "blocker",
  high: "major",
  medium: "minor",
  low: "nit",
} as const;

/** Monitor finding fields are length-capped by contract; keep the longest valid value. */
const truncate = (value: string, max: number) =>
  value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";

/**
 * Finding ids are positional (`finding-1`), so they reorder across re-reviews. Derive a
 * content-stable key over all stable finding content so re-submitting an unchanged finding
 * updates its durable item instead of forking it, and distinct findings never collide.
 */
export const reviewFindingKey = (input: {
  readonly diffHash: string;
  readonly path: string;
  readonly startLine: number;
  readonly title: string;
  readonly body: string;
  readonly priority: string;
}): string =>
  createHash("sha1")
    .update(
      `${input.diffHash}\n${input.path}:${input.startLine}\n${input.priority}\n${input.title}\n${input.body}`,
    )
    .digest("hex")
    .slice(0, 16);

export interface ParsedPullRequestReview {
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly repository: string;
  readonly number: number;
  readonly diffHash: string;
  readonly summary: string;
  readonly findings: readonly {
    readonly id: string;
    readonly priority: "critical" | "high" | "medium" | "low";
    readonly title: string;
    readonly body: string;
    readonly location: { readonly path: string; readonly startLine: number };
  }[];
}

/**
 * Convert a persisted PR review result into a submitFindings handoff. Non-PR scopes,
 * invalid output, and zero-finding reviews do not qualify.
 */
export function handoffFromReviewResult(input: {
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly result: ReviewResult;
}): ParsedPullRequestReview | null {
  if (input.result.status !== "parsed" || input.result.findings.length === 0) return null;
  const scope = input.result.snapshot.scope;
  if (scope.kind !== "pull-request") return null;
  const repository = repositoryFromPullRequestUrl(scope.url);
  if (repository === null) return null;
  return {
    reviewThreadId: input.reviewThreadId,
    projectId: input.projectId,
    repository,
    number: scope.number,
    diffHash: input.result.snapshot.diffHash,
    summary: input.result.summary,
    findings: input.result.findings.map((finding) => ({
      id: finding.id,
      priority: finding.priority,
      title: finding.title,
      body: finding.body,
      location: { path: finding.location.path, startLine: finding.location.startLine },
    })),
  };
}

export function handoffToSubmitInput(
  review: ParsedPullRequestReview,
): PullRequestMonitorSubmitFindingsInput {
  return {
    reference: {
      projectId: review.projectId ?? ("" as ProjectId),
      repository: review.repository,
      number: review.number,
    },
    reviewThreadId: review.reviewThreadId,
    summary: truncate(review.summary, 2_000),
    findings: review.findings.map((finding): PullRequestMonitorFinding => {
      const key = reviewFindingKey({
        diffHash: review.diffHash,
        path: finding.location.path,
        startLine: finding.location.startLine,
        title: finding.title,
        body: finding.body,
        priority: finding.priority,
      });
      return {
        key: `review-${key}`,
        title: truncate(finding.title, 200),
        detail: truncate(finding.body, 2_000),
        severity: SEVERITY_BY_PRIORITY[finding.priority],
        path: truncate(finding.location.path, 500),
        line: finding.location.startLine,
      };
    }),
  };
}

const isHandoffEvent = (
  event: OrchestrationEvent,
): event is OrchestrationEvent & {
  readonly payload: { readonly threadId: ThreadId; readonly result: ReviewResult };
} =>
  event.aggregateKind === "thread" &&
  event.type === "thread.review-result-set" &&
  typeof (event.payload as { threadId?: unknown }).threadId === "string" &&
  Boolean((event.payload as { result?: unknown }).result);

/**
 * Hand parsed PR review findings to the canonical monitor pipeline so they become durable,
 * individually addressable items delivered to the owning chat. Ownership stays with the
 * existing monitor owner; only linkedReviewThreadId moves to the review chat.
 *
 * Consumption is at-least-once: on startup the persisted cursor replays everything since
 * the last successful handoff, merged with the live stream (duplicates are dropped by
 * sequence). The cursor advances only after a successful submit; a transient failure
 * retries with backoff, and an event that keeps failing stays behind the cursor so a
 * restart retries it again. Settings gate the behaviour, and failures never block the
 * review itself or other events behind them.
 */
const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const serverSettings = yield* ServerSettingsService;
  const projectionState = yield* ProjectionStateRepository;

  const initial = yield* projectionState.getByProjector({ projector: REVIEW_HANDOFF_PROJECTOR });
  // Highest sequence fully handled. Events above it are pending or skipped-this-session.
  const processed = yield* Ref.make(
    Option.match(initial, {
      onNone: () => 0,
      onSome: (state) => state.lastAppliedSequence,
    }),
  );
  const skipped = yield* Ref.make(new Set<number>());

  const advanceCursor = Effect.fn("advanceCursor")(function* (sequence: number) {
    const current = yield* Ref.getAndUpdate(processed, (value) => Math.max(value, sequence));
    if (sequence <= current) return;
    yield* projectionState
      .upsert({
        projector: REVIEW_HANDOFF_PROJECTOR,
        lastAppliedSequence: sequence,
        updatedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catchCause((cause) =>
          // Worst case the event replays after a restart; submits are idempotent.
          Effect.logWarning("pr review handoff cursor persist failed", {
            sequence,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const handle = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (!isHandoffEvent(event)) return;
      const settings = yield* Effect.result(serverSettings.getSettings);
      if (Result.isFailure(settings) || settings.success.autoMonitorPullRequestsOnCreate !== true) {
        return;
      }
      const readModel = yield* engine.getReadModel();
      const projectId = (readModel.threads.find((entry) => entry.id === event.payload.threadId)
        ?.projectId ?? null) as ProjectId | null;
      const review = handoffFromReviewResult({
        reviewThreadId: event.payload.threadId,
        projectId,
        result: event.payload.result,
      });
      if (review === null || !review.projectId) return;
      // Errors propagate to process(): retried transiently, then skipped until restart.
      yield* monitors.submitFindings(handoffToSubmitInput(review));
    });

  const process = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(processed);
      if (event.sequence <= current || (yield* Ref.get(skipped)).has(event.sequence)) return;
      const outcome = yield* Effect.result(handle(event).pipe(Effect.retry(SUBMIT_RETRY)));
      if (Result.isSuccess(outcome)) {
        yield* advanceCursor(event.sequence);
        return;
      }
      // Keep looping: mark this event skipped for this session but leave the cursor
      // behind it so a restart replays and re-attempts it.
      yield* Ref.update(skipped, (set) => new Set(set).add(event.sequence));
      yield* Effect.logError("pr review handoff gave up; will retry after restart", {
        sequence: event.sequence,
        type: event.type,
      });
    });

  // Merge replay-since-cursor with the live stream: neither a restart gap nor events
  // dispatched during catch-up can be lost. runForEach keeps handling sequential.
  yield* engine.readEvents(yield* Ref.get(processed)).pipe(
    Stream.merge(engine.streamDomainEvents),
    Stream.runForEach(process),
    Effect.catchCause((cause) =>
      Effect.logWarning("pr review handoff stream terminated", {
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.interruptible,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(makeReactor);
