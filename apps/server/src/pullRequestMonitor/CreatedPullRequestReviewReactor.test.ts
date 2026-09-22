import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationThread,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  createdPullRequestLinks,
  reconcileCreatedPullRequestReview,
} from "./CreatedPullRequestReviewReactor.ts";

const threadId = ThreadId.make("created-pr-review-thread");
const projectId = ProjectId.make("created-pr-review-project");

const link = (source: ThreadPullRequestLink["source"]): ThreadPullRequestLink => ({
  source,
  linkedAt: "2026-09-22T00:00:00.000Z",
  pullRequest: {
    title: "Created pull request",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    baseBranch: "main",
    headBranch: "feature",
    state: "open",
  },
});

const thread = (
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread =>
  ({
    id: threadId,
    projectId,
    pullRequests,
    messages: [],
    activities: [],
    latestTurn: null,
    session: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationThread;

const observation = (headSha: string, state: "open" | "closed" | "merged" = "open") => ({
  state,
  repository: "owner/repo",
  number: 42,
  headSha,
  sourceRevision: `provider:${headSha}`,
});

describe("created pull-request review reconciliation", () => {
  it("admits an inactive created PR with the authoritative current head", async () => {
    const submitted: string[] = [];
    let refreshCount = 0;
    const current = thread([link("created")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => {
          refreshCount += 1;
          return Effect.succeed(observation("head-2"));
        },
        readCurrentThread: () => Effect.succeed(current),
        submit: ({ observation: refreshed }) =>
          Effect.sync(() => {
            submitted.push(refreshed.headSha);
          }),
      }),
    );

    assert.strictEqual(refreshCount, 1);
    assert.deepStrictEqual(submitted, ["head-2"]);
  });

  it("does not admit while the creating thread is active", async () => {
    let submitted = 0;
    const active = thread([link("created")], {
      latestTurn: {
        state: "running",
      },
    } as Partial<OrchestrationThread>);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(active, {
        refresh: () => Effect.succeed(observation("head-1")),
        readCurrentThread: () => Effect.succeed(active),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("ignores manual and recovered associations", async () => {
    let submitted = 0;
    const current = thread([link("manual"), link("recovered")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-1")),
        readCurrentThread: () => Effect.succeed(current),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("ignores closed pull requests", async () => {
    let submitted = 0;
    const current = thread([link("agent")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-1", "closed")),
        readCurrentThread: () => Effect.succeed(current),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("re-checks durable thread state after refresh", async () => {
    let submitted = 0;
    const initial = thread([link("created")]);
    const activeAfterRefresh = thread([link("created")], {
      latestTurn: { state: "running" },
    } as Partial<OrchestrationThread>);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(initial, {
        refresh: () => Effect.succeed(observation("head-3")),
        readCurrentThread: () => Effect.succeed(activeAfterRefresh),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("reconciliation is safe to repeat when admission is idempotent", async () => {
    const submitted = new Set<string>();
    const current = thread([link("created")]);
    const reconcile = () =>
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-4")),
        readCurrentThread: () => Effect.succeed(current),
        submit: ({ observation: refreshed }) =>
          Effect.sync(() => {
            submitted.add(refreshed.headSha);
          }),
      });

    await Effect.runPromise(Effect.all([reconcile(), reconcile()], { concurrency: 2 }));

    assert.deepStrictEqual([...submitted], ["head-4"]);
  });

  it("filters only durable creation sources", () => {
    assert.deepStrictEqual(
      createdPullRequestLinks({
        pullRequests: [link("manual"), link("created"), link("agent"), link("recovered")],
      }).map((item) => item.source),
      ["created", "agent"],
    );
  });
});
