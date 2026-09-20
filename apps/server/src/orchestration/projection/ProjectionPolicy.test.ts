import { describe, expect, it } from "vitest";

import {
  chunkRevertTrimIds,
  extraRetainedMessageIdsFromTurns,
  planMetaUpdatedPullRequestLinks,
  resolveInitialThreadPullRequest,
  selectRetainedMessageIds,
  selectRetainedTurnIds,
  selectTrimmedTurnIds,
  shouldPreserveActiveMessageId,
  terminalTurnStateForSessionStatus,
} from "./ProjectionPolicy.ts";

describe("ProjectionPolicy", () => {
  it("resolves an explicit thread.created association as created", () => {
    const pullRequest = {
      number: 7,
      title: "Add feature",
      url: "https://github.com/acme/repo/pull/7",
      baseBranch: "main",
      headBranch: "feature",
      state: null,
    } as const;
    expect(resolveInitialThreadPullRequest({ pullRequest, reviewSnapshot: undefined })).toEqual({
      initialPullRequest: pullRequest,
      source: "created",
    });
  });

  it("recovers a thread.created association from a pull-request review snapshot", () => {
    const { initialPullRequest, source } = resolveInitialThreadPullRequest({
      pullRequest: undefined,
      reviewSnapshot: {
        scope: {
          kind: "pull-request",
          number: 9,
          title: "Fix bug",
          url: "https://github.com/acme/repo/pull/9",
          baseBranch: "main",
          headBranch: "fix",
        },
      } as never,
    });
    expect(source).toBe("recovered");
    expect(initialPullRequest?.number).toBe(9);
  });

  it("seeds a missing legacy association ahead of newer pullRequests", () => {
    const legacy = {
      number: 1,
      title: "First",
      url: "https://github.com/acme/repo/pull/1",
      baseBranch: "main",
      headBranch: "first",
      state: null,
    } as const;
    const next = {
      number: 2,
      title: "Second",
      url: "https://github.com/acme/repo/pull/2",
      baseBranch: "main",
      headBranch: "second",
      state: null,
    } as const;
    const plan = planMetaUpdatedPullRequestLinks({
      existingLinks: [],
      existingLegacyPullRequest: legacy,
      createdAt: "2026-01-01T00:00:00.000Z",
      nextPullRequest: next,
      updatedAt: "2026-01-02T00:00:00.000Z",
      source: "manual",
    });
    expect(plan.recoveredLegacyLink?.pullRequest.number).toBe(1);
    expect(plan.allLinks.map((link) => link.pullRequest.number)).toEqual([1, 2]);
  });

  it("retains system messages and fills user/assistant counts up to turnCount", () => {
    const messages = [
      { messageId: "sys", turnId: null, role: "system", createdAt: "2026-01-01T00:00:00.000Z" },
      { messageId: "u1", turnId: "turn-1", role: "user", createdAt: "2026-01-01T00:00:01.000Z" },
      {
        messageId: "a1",
        turnId: "turn-1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      { messageId: "u2", turnId: null, role: "user", createdAt: "2026-01-01T00:00:03.000Z" },
      {
        messageId: "a2",
        turnId: "turn-2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ];
    const retained = selectRetainedMessageIds(messages, new Set(["turn-1"]), 1);
    expect([...retained].sort()).toEqual(["a1", "sys", "u1"]);
  });

  it("selects retained turn ids by checkpointTurnCount", () => {
    expect(
      selectRetainedTurnIds(
        [
          { turnId: "turn-1", checkpointTurnCount: 1 },
          { turnId: "turn-2", checkpointTurnCount: 2 },
          { turnId: null, checkpointTurnCount: 1 },
        ],
        1,
      ),
    ).toEqual(["turn-1"]);
  });

  it("keeps pending/assistant message ids from kept turns", () => {
    const extra = extraRetainedMessageIdsFromTurns(
      [
        {
          turnId: "turn-1",
          checkpointTurnCount: 1,
          pendingMessageId: "p1",
          assistantMessageId: "a1",
        },
        {
          turnId: "turn-2",
          checkpointTurnCount: 2,
          pendingMessageId: "p2",
          assistantMessageId: null,
        },
      ],
      1,
    );
    expect([...extra].sort()).toEqual(["a1", "p1"]);
  });

  it("trims present turn ids minus retained ids and chunks deletes", () => {
    expect(selectTrimmedTurnIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    expect(selectTrimmedTurnIds(["a", "b"], [])).toEqual(["a", "b"]);
    expect(chunkRevertTrimIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });

  it("maps terminal session status and active-message preservation", () => {
    expect(terminalTurnStateForSessionStatus("error")).toBe("error");
    expect(terminalTurnStateForSessionStatus("idle")).toBe("interrupted");
    expect(
      shouldPreserveActiveMessageId({ activeTurnId: "turn-1", activeMessageId: undefined }),
    ).toBe(true);
    expect(shouldPreserveActiveMessageId({ activeTurnId: null, activeMessageId: undefined })).toBe(
      false,
    );
  });
});
