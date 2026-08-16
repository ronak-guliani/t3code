import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";

import {
  associationFromEvent,
  repositoryFromPullRequestUrl,
} from "./PullRequestMonitorAssociationReactor.ts";

const event = (type: string, payload: Record<string, unknown>): OrchestrationEvent =>
  ({
    aggregateKind: "thread",
    aggregateId: "thr_1",
    type,
    payload,
  }) as unknown as OrchestrationEvent;

const pullRequest = {
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  title: "Add monitor",
  baseBranch: "main",
  headBranch: "feat",
  state: "open",
};

describe("associationFromEvent", () => {
  it("treats a pull request association as the ownership signal", () => {
    const created = associationFromEvent(
      event("thread.created", { threadId: "thr_1", projectId: "proj_1", pullRequest }),
    );
    expect(created).toEqual({
      threadId: "thr_1",
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
    });

    const updated = associationFromEvent(
      event("thread.meta-updated", { threadId: "thr_1", pullRequest }),
    );
    expect(updated?.repository).toBe("acme/app");
    expect(updated?.projectId).toBe("");
  });

  it("ignores lifecycle events that carry no association", () => {
    expect(associationFromEvent(event("thread.meta-updated", { threadId: "thr_1" }))).toBeNull();
    expect(
      associationFromEvent(event("thread.meta-updated", { threadId: "thr_1", pullRequest: null })),
    ).toBeNull();
    expect(associationFromEvent(event("thread.turn.started", { threadId: "thr_1" }))).toBeNull();
  });

  it("ignores an association whose repository cannot be derived", () => {
    expect(
      associationFromEvent(
        event("thread.created", {
          threadId: "thr_1",
          projectId: "proj_1",
          pullRequest: { ...pullRequest, url: "not-a-url" },
        }),
      ),
    ).toBeNull();
  });

  it("reads owner/name out of a pull request url", () => {
    expect(repositoryFromPullRequestUrl("https://github.com/acme/app/pull/12")).toBe("acme/app");
    expect(repositoryFromPullRequestUrl("https://ghe.example.com/team/repo/pull/7")).toBe(
      "team/repo",
    );
    expect(repositoryFromPullRequestUrl(null)).toBeNull();
    expect(repositoryFromPullRequestUrl("https://github.com/acme")).toBeNull();
  });
});
