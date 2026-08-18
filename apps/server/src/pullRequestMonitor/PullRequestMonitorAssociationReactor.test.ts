import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";

import {
  associationFromEvent,
  associationOwnerThreadId,
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
      parentThreadId: null,
      ownershipMode: "transfer",
      repository: "acme/app",
      number: 12,
    });

    const refreshed = associationFromEvent(
      event("thread.meta-updated", { threadId: "thr_1", pullRequest }),
    );
    expect(refreshed?.repository).toBe("acme/app");
    expect(refreshed?.projectId).toBe("");
    expect(refreshed?.ownershipMode).toBe("preserve");

    const explicit = associationFromEvent(
      event("thread.meta-updated", {
        threadId: "thr_1",
        pullRequest,
        pullRequestOwnership: "transfer",
      }),
    );
    expect(explicit?.ownershipMode).toBe("transfer");
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

describe("associationOwnerThreadId", () => {
  const projectId = ProjectId.make("proj_1");
  const thread = (input: {
    id: string;
    parentThreadId?: string | null;
    pullRequest?: { number: number; url: string } | null;
  }) => ({
    id: ThreadId.make(input.id),
    projectId,
    parentThreadId:
      input.parentThreadId === undefined || input.parentThreadId === null
        ? null
        : ThreadId.make(input.parentThreadId),
    pullRequest: input.pullRequest ?? null,
    archivedAt: null,
    deletedAt: null,
  });

  it("keeps inherited workflow PR metadata owned by the associated parent", () => {
    const association = associationFromEvent(
      event("thread.created", {
        threadId: "review-worker",
        projectId: "proj_1",
        parentThreadId: "owner",
        pullRequest,
      }),
    );
    expect(association).not.toBeNull();
    expect(association?.ownershipMode).toBe("preserve");
    expect(
      associationOwnerThreadId(
        [
          thread({ id: "owner", pullRequest }),
          thread({ id: "review-worker", parentThreadId: "owner", pullRequest }),
        ],
        association!,
        projectId,
      ),
    ).toBe("owner");
  });

  it("uses ancestry only as the inherited fallback for descendants and siblings", () => {
    const threads = [
      thread({ id: "root", pullRequest }),
      thread({ id: "explicit-owner", parentThreadId: "root", pullRequest }),
      thread({ id: "grandchild", parentThreadId: "explicit-owner", pullRequest }),
      thread({ id: "sibling-worker", parentThreadId: "root", pullRequest }),
    ];
    for (const [threadId, parentThreadId] of [
      ["grandchild", "explicit-owner"],
      ["sibling-worker", "root"],
    ] as const) {
      const association = associationFromEvent(
        event("thread.created", {
          threadId,
          projectId: "proj_1",
          parentThreadId,
          pullRequest,
        }),
      );
      expect(association).not.toBeNull();
      expect(associationOwnerThreadId(threads, association!, projectId)).toBe("root");
    }
  });

  it("still treats an explicit metadata association as an ownership transfer", () => {
    const association = associationFromEvent(
      event("thread.meta-updated", {
        threadId: "child",
        pullRequest,
        pullRequestOwnership: "transfer",
      }),
    );
    expect(association).not.toBeNull();
    expect(
      associationOwnerThreadId(
        [
          thread({ id: "owner", pullRequest }),
          thread({ id: "child", parentThreadId: "owner", pullRequest }),
        ],
        association!,
        projectId,
      ),
    ).toBe("child");
  });

  it("uses ancestry as the fallback for refreshed inherited metadata", () => {
    const association = associationFromEvent(
      event("thread.meta-updated", {
        threadId: "review-worker",
        pullRequest,
      }),
    );
    expect(association).not.toBeNull();
    expect(
      associationOwnerThreadId(
        [
          thread({ id: "owner", pullRequest }),
          thread({ id: "review-worker", parentThreadId: "owner", pullRequest }),
        ],
        association!,
        projectId,
      ),
    ).toBe("owner");
  });
});
