import { ProjectId, type PullRequestListEntry } from "@t3tools/contracts";
import { act, type ReactNode, useCallback, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderCounts = vi.hoisted(() => ({ rows: 0 }));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    readonly render: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));

vi.mock("./pullRequestPresentation", () => ({
  PullRequestActorLabel: () => null,
  PullRequestDiffStat: () => null,
  PullRequestMetaLine: () => null,
  PullRequestStateGlyph: () => {
    renderCounts.rows += 1;
    return null;
  },
  pullRequestLabelColor: () => null,
}));

import { PullRequestRow } from "./PullRequestRow";

const firstEntry: PullRequestListEntry = {
  provider: "github",
  host: "github.com",
  projectId: ProjectId.make("project-1"),
  projectTitle: "T3 Code",
  repository: "t3tools/t3code",
  number: 1,
  title: "First pull request",
  url: "https://github.com/t3tools/t3code/pull/1",
  author: { login: "octocat", name: "The Octocat", avatarUrl: null },
  headBranch: "feature/1",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 3,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  viewerReviewRequested: false,
  labels: [],
};

const secondEntry: PullRequestListEntry = {
  ...firstEntry,
  number: 2,
  title: "Second pull request",
  url: "https://github.com/t3tools/t3code/pull/2",
  headBranch: "feature/2",
};

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  renderCounts.rows = 0;
  vi.unstubAllGlobals();
});

describe("PullRequestRow memoization", () => {
  it("skips unchanged rows and rerenders only changed or newly selected rows", () => {
    function Harness() {
      const [selectedNumber, setSelectedNumber] = useState(1);
      const [revision, setRevision] = useState(0);
      const [refreshVersion, setRefreshVersion] = useState(0);
      const onSelect = useCallback(() => undefined, []);
      const currentFirstEntry =
        revision === 0 ? firstEntry : { ...firstEntry, title: "Updated first pull request" };

      return (
        <>
          <button
            type="button"
            data-action="refresh"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            Refresh {refreshVersion}
          </button>
          <button type="button" data-action="change" onClick={() => setRevision(1)}>
            Change
          </button>
          <button type="button" data-action="select-second" onClick={() => setSelectedNumber(2)}>
            Select second
          </button>
          <PullRequestRow
            entry={currentFirstEntry}
            selected={selectedNumber === 1}
            onSelect={onSelect}
          />
          <PullRequestRow entry={secondEntry} selected={selectedNumber === 2} onSelect={onSelect} />
        </>
      );
    }

    act(() => {
      renderer = create(<Harness />);
    });
    expect(renderCounts.rows).toBe(2);
    renderCounts.rows = 0;

    act(() => {
      renderer?.root.findByProps({ "data-action": "refresh" }).props.onClick();
    });
    expect(renderCounts.rows).toBe(0);

    act(() => {
      renderer?.root.findByProps({ "data-action": "change" }).props.onClick();
    });
    expect(renderCounts.rows).toBe(1);
    renderCounts.rows = 0;

    act(() => {
      renderer?.root.findByProps({ "data-action": "select-second" }).props.onClick();
    });
    expect(renderCounts.rows).toBe(2);
  });
});
