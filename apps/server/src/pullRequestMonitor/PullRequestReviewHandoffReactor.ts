import {
  type OrchestrationEvent,
  type ProjectId,
  type PullRequestMonitorFinding,
  type PullRequestMonitorSubmitFindingsInput,
  type ReviewResult,
  type ThreadId,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

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
 * content-stable key instead so re-submitting an unchanged finding updates its durable
 * item instead of forking it.
 */
export const reviewFindingKey = (input: {
  readonly diffHash: string;
  readonly path: string;
  readonly startLine: number;
  readonly title: string;
}): string =>
  createHash("sha1")
    .update(`${input.diffHash}\n${input.path}:${input.startLine}\n${input.title}`)
    .digest("hex")
    .slice(0, 16);

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

/**
 * Hand parsed PR review findings to the canonical monitor pipeline so they become durable,
 * individually addressable items delivered to the owning chat. Ownership stays with the
 * existing monitor owner; only linkedReviewThreadId moves to the review chat.
 * Settings gate the behaviour, and a failure here never blocks the review itself.
 */
const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const serverSettings = yield* ServerSettingsService;

  const handle = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.aggregateKind !== "thread" || event.type !== "thread.review-result-set") return;
      const payload = event.payload as {
        readonly threadId?: unknown;
        readonly result?: ReviewResult;
      };
      if (typeof payload.threadId !== "string" || !payload.result) return;
      const settings = yield* Effect.result(serverSettings.getSettings);
      if (Result.isFailure(settings) || settings.success.autoMonitorPullRequestsOnCreate !== true) {
        return;
      }
      const readModel = yield* engine.getReadModel();
      const projectId = (readModel.threads.find((entry) => entry.id === payload.threadId)
        ?.projectId ?? null) as ProjectId | null;
      const review = handoffFromReviewResult({
        reviewThreadId: payload.threadId as ThreadId,
        projectId,
        result: payload.result,
      });
      if (review === null || !review.projectId) return;
      yield* monitors.submitFindings(handoffToSubmitInput(review)).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("pr review handoff skipped", {
            threadId: review.reviewThreadId,
            repository: review.repository,
            number: review.number,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pr review handoff reactor failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
