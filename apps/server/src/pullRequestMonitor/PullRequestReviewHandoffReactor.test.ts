import {
  type OrchestrationEvent,
  ProjectId,
  type PullRequestMonitorSubmitFindingsInput,
  type ReviewResult,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  handoffFromReviewResult,
  handoffToSubmitInput,
  layer,
  REVIEW_HANDOFF_PROJECTOR,
  reviewFindingKey,
} from "./PullRequestReviewHandoffReactor.ts";

const snapshot = {
  scope: {
    kind: "pull-request" as const,
    number: 12,
    title: "Add monitor",
    url: "https://github.com/acme/app/pull/12",
    baseBranch: "main",
    headBranch: "feat",
  },
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\n",
  diffHash: "diffhash-1",
};

const finding = (
  overrides: Partial<{
    id: string;
    priority: string;
    title: string;
    body: string;
    path: string;
    startLine: number;
  }> = {},
) => ({
  id: overrides.id ?? "finding-1",
  priority: (overrides.priority ?? "high") as "critical" | "high" | "medium" | "low",
  title: overrides.title ?? "Null deref",
  body: overrides.body ?? "This can be null.",
  confidence: 0.9,
  location: {
    path: overrides.path ?? "src/a.ts",
    side: "new" as const,
    startLine: overrides.startLine ?? 2,
    endLine: overrides.startLine ?? 2,
  },
});

const parsed = (findings = [finding()], snapshotOverride = {}) => ({
  status: "parsed" as const,
  snapshot: { ...snapshot, ...snapshotOverride },
  findings,
  verdict: "request-changes" as const,
  summary: "Two issues found.",
});

describe("handoffFromReviewResult", () => {
  const projectId = ProjectId.make("proj_1");

  it("converts a parsed PR review into a handoff", () => {
    const handoff = handoffFromReviewResult({
      reviewThreadId: ThreadId.make("thr_review"),
      projectId,
      result: parsed(),
    });
    expect(handoff).toMatchObject({
      reviewThreadId: "thr_review",
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
      summary: "Two issues found.",
    });
    expect(handoff?.findings).toHaveLength(1);
  });

  it("ignores invalid output, zero-finding reviews, and non-PR scopes", () => {
    const input = { reviewThreadId: ThreadId.make("thr"), projectId };
    expect(
      handoffFromReviewResult({
        ...input,
        result: { status: "invalid-output", snapshot, issues: ["bad"] } as ReviewResult,
      }),
    ).toBeNull();
    expect(handoffFromReviewResult({ ...input, result: parsed([]) })).toBeNull();
    expect(
      handoffFromReviewResult({
        ...input,
        result: parsed([finding()], {
          scope: { kind: "uncommitted", branch: "main", untrackedFiles: [] },
        }),
      }),
    ).toBeNull();
  });

  it("ignores a PR url whose repository cannot be derived", () => {
    expect(
      handoffFromReviewResult({
        reviewThreadId: ThreadId.make("thr"),
        projectId,
        result: parsed([finding()], {
          scope: { ...snapshot.scope, url: "not-a-url" },
        }),
      }),
    ).toBeNull();
  });
});

describe("handoffToSubmitInput", () => {
  const review = handoffFromReviewResult({
    reviewThreadId: ThreadId.make("thr_review"),
    projectId: ProjectId.make("proj_1"),
    result: parsed([
      finding({ priority: "critical" }),
      finding({ id: "finding-2", priority: "medium", title: "Naming", startLine: 3 }),
      finding({ id: "finding-3", priority: "low", title: "Typo", startLine: 4 }),
    ]),
  })!;

  it("preserves reference, locations, and maps priorities to severities", () => {
    const input = handoffToSubmitInput(review);
    const findings = input.findings ?? [];
    expect(input.reference).toEqual({
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
    });
    expect(input.reviewThreadId).toBe("thr_review");
    expect(findings.map((entry) => entry.severity)).toEqual(["blocker", "minor", "nit"]);
    expect(findings[0]).toMatchObject({ path: "src/a.ts", line: 2 });
  });

  it("derives content-stable keys that survive positional reordering", () => {
    const first = (handoffToSubmitInput(review).findings ?? []).map((entry) => entry.key);
    // Same content in a different order must keep each finding's key stable.
    const reordered = (
      handoffToSubmitInput({ ...review, findings: [...review.findings].reverse() }).findings ?? []
    ).map((entry) => entry.key);
    expect([...reordered].sort()).toEqual([...first].sort());
  });

  it("truncates fields beyond contract limits instead of rejecting the submit", () => {
    const long = "x".repeat(3_000);
    const input = handoffToSubmitInput({
      ...review,
      summary: long,
      findings: [
        {
          id: "f",
          priority: "high",
          title: long,
          body: long,
          location: { path: long, startLine: 1 },
        },
      ],
    });
    const [finding] = input.findings ?? [];
    expect(input.summary!.length).toBeLessThanOrEqual(2_000);
    expect(finding!.title.length).toBeLessThanOrEqual(200);
    expect(finding!.detail.length).toBeLessThanOrEqual(2_000);
    expect(finding!.path!.length).toBeLessThanOrEqual(500);
  });

  it("keys differ when any stable content differs", () => {
    const keyOf = (overrides: Partial<Parameters<typeof reviewFindingKey>[0]> = {}) =>
      reviewFindingKey({
        diffHash: "h",
        path: "a.ts",
        startLine: 2,
        title: "t",
        body: "b",
        priority: "high",
        ...overrides,
      });
    const base = keyOf();
    expect(base).not.toBe(keyOf({ title: "other" }));
    expect(base).not.toBe(keyOf({ body: "other body" }));
    expect(base).not.toBe(keyOf({ priority: "low" }));
    expect(base).not.toBe(keyOf({ path: "b.ts" }));
    expect(base).not.toBe(keyOf({ startLine: 3 }));
    expect(base).not.toBe(keyOf({ diffHash: "h2" }));
    expect(keyOf()).toBe(keyOf());
  });

  it("findings sharing title and location but differing in body keep distinct keys", () => {
    const collidingReview = {
      ...review,
      findings: [
        ...review.findings,
        { ...review.findings[0]!, id: "finding-dup", body: "Different detail." },
      ],
    };
    const keys = (handoffToSubmitInput(collidingReview).findings ?? []).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const makeEvent = (sequence: number, result: unknown): OrchestrationEvent =>
  ({
    sequence,
    eventId: `evt_${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thr_review",
    type: "thread.review-result-set",
    payload: { threadId: "thr_review", result },
    occurredAt: new Date().toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  }) as unknown as OrchestrationEvent;

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 750; attempt += 1) {
      if (predicate()) return true;
      yield* Effect.sleep("20 millis");
    }
    return false;
  });

interface Harness {
  readonly calls: readonly PullRequestMonitorSubmitFindingsInput[];
  readonly cursorRows: ReadonlyMap<string, number>;
}

const makeHarness = (options: {
  readonly events: readonly OrchestrationEvent[];
  readonly autoMonitor?: boolean;
  readonly initialCursor?: number;
  readonly submitFindings?: (
    input: PullRequestMonitorSubmitFindingsInput,
  ) => Effect.Effect<void, Error>;
}): Harness & { readonly layer: Layer.Layer<never> } => {
  const calls: PullRequestMonitorSubmitFindingsInput[] = [];
  const cursorRows = new Map<string, number>();
  if (options.initialCursor !== undefined) {
    cursorRows.set(REVIEW_HANDOFF_PROJECTOR, options.initialCursor);
  }
  let submit: (input: PullRequestMonitorSubmitFindingsInput) => Effect.Effect<void, Error> = () =>
    Effect.void;
  if (options.submitFindings) {
    const scripted = options.submitFindings;
    submit = scripted;
  }
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.succeed({ threads: [{ id: "thr_review", projectId: "proj_1" }], projects: [] }),
    readEvents: () => Stream.fromIterable(options.events),
    streamDomainEvents: Stream.empty,
  } as unknown as OrchestrationEngineService["Service"]);
  const monitorLayer = Layer.succeed(PullRequestMonitorService, {
    submitFindings: (input: PullRequestMonitorSubmitFindingsInput) =>
      submit(input).pipe(
        Effect.tap(() => Effect.sync(() => calls.push(input))),
        Effect.as({} as never),
      ),
  } as unknown as PullRequestMonitorService["Service"]);
  const settingsLayer = ServerSettingsService.layerTest({
    autoMonitorPullRequestsOnCreate: options.autoMonitor ?? true,
  });
  const stateLayer = Layer.succeed(ProjectionStateRepository, {
    getByProjector: ({ projector }: { projector: string }) =>
      Effect.succeed(
        cursorRows.has(projector)
          ? Option.some({
              projector,
              lastAppliedSequence: cursorRows.get(projector)!,
              updatedAt: new Date().toISOString(),
            })
          : Option.none(),
      ),
    upsert: (row: { projector: string; lastAppliedSequence: number }) =>
      Effect.sync(() => {
        cursorRows.set(row.projector, row.lastAppliedSequence);
      }),
  } as unknown as ProjectionStateRepository["Service"]);
  return {
    get calls() {
      return calls;
    },
    get cursorRows() {
      return cursorRows;
    },
    layer: layer.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(monitorLayer),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(stateLayer),
    ) as unknown as Layer.Layer<never>,
  };
};

const runWithLayer = <A, E>(effect: Effect.Effect<A, E, never>, testLayer: Layer.Layer<never>) =>
  Effect.runPromiseExit(Effect.provide(effect, testLayer));

describe("PullRequestReviewHandoffReactor layer", () => {
  it("submits parsed PR findings and advances the durable cursor", async () => {
    const harness = makeHarness({ events: [makeEvent(7, parsed())] });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        expect(harness.calls[0]).toMatchObject({
          reference: { projectId: "proj_1", repository: "acme/app", number: 12 },
          reviewThreadId: "thr_review",
        });
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect((result as { value?: number }).value).toBe(7);
  }, 20_000);

  it("does nothing when the settings gate is off or the event does not qualify", async () => {
    for (const options of [
      { events: [makeEvent(3, parsed())], autoMonitor: false },
      { events: [makeEvent(3, { status: "invalid-output", snapshot, issues: ["bad"] })] },
      { events: [makeEvent(3, parsed([]))] },
      { events: [makeEvent(3, { type: "thread.message-sent", payload: {} })] },
    ]) {
      const harness = makeHarness(options);
      const result = await runWithLayer(
        Effect.gen(function* () {
          yield* Effect.sleep("300 millis");
          return harness.calls.length;
        }),
        harness.layer,
      );
      expect(result._tag).toBe("Success");
      expect((result as { value?: number }).value).toBe(0);
    }
  }, 20_000);

  it("retries a transient failure until the idempotent submit succeeds", async () => {
    let attempts = 0;
    const harness = makeHarness({
      events: [makeEvent(5, parsed())],
      submitFindings: () => (++attempts === 1 ? Effect.fail(new Error("transient")) : Effect.void),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length >= 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((result as { value?: number }).value).toBe(5);
  }, 30_000);

  it("leaves the cursor behind a persistently failing event so restart retries it", async () => {
    let attempts = 0;
    const harness = makeHarness({
      events: [makeEvent(9, parsed())],
      submitFindings: () =>
        Effect.gen(function* () {
          attempts += 1;
          return yield* Effect.fail(new Error("permanent"));
        }),
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        yield* Effect.sleep("3 seconds");
        return { cursor: harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR), attempts };
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect(attempts).toBeGreaterThan(0);
    const value = (result as { value?: { cursor?: number } }).value;
    expect(value?.cursor).toBeUndefined();
  }, 20_000);

  it("resumes from a persisted cursor instead of replaying already-handled events", async () => {
    const harness = makeHarness({
      events: [makeEvent(4, parsed()), makeEvent(7, parsed())],
      initialCursor: 4,
    });
    const result = await runWithLayer(
      Effect.gen(function* () {
        const delivered = yield* waitFor(() => harness.calls.length === 1);
        expect(delivered).toBe(true);
        return harness.cursorRows.get(REVIEW_HANDOFF_PROJECTOR);
      }),
      harness.layer,
    );
    expect(result._tag).toBe("Success");
    expect((result as { value?: number }).value).toBe(7);
  }, 20_000);
});
