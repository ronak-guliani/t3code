import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { ThreadDetailsTooltip } from "./SidebarV2ThreadTooltip";

vi.mock("./ui/tooltip", () => ({
  TooltipPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const thread: SidebarThreadSummary = {
  id: ThreadId.make("hover-thread"),
  environmentId: EnvironmentId.make("hover-environment"),
  projectId: ProjectId.make("hover-project"),
  parentThreadId: null,
  title: "Improve Codebase Architecture",
  interactionMode: "default",
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: "refactor/projection-reconciliation",
  worktreePath: "/worktrees/projection-reconciliation",
  pullRequest: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasPendingQueuedTurn: false,
};

describe("ThreadDetailsTooltip", () => {
  it("shows the worktree even when the project path is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailsTooltip
        thread={thread}
        projectName="t3code"
        projectCwd={null}
        environmentLabel={null}
        providerEntry={null}
        terminalProcessCount={0}
      />,
    );

    expect(markup).toContain(thread.title);
    expect(markup).toContain(thread.branch);
    expect(markup).toContain(thread.worktreePath);
    expect(markup).not.toContain("terminal process");
  });

  it("preserves remote, terminal, and pull request details in the compact card", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailsTooltip
        thread={{
          ...thread,
          worktreePath: null,
          pullRequest: {
            number: 273,
            title: "Separate projection reconciliation",
            url: "https://example.test/pull/273",
            baseBranch: "main",
            headBranch: "refactor/projection-reconciliation",
            state: "merged",
          },
        }}
        projectName="t3code"
        projectCwd="/projects/t3code"
        environmentLabel="Build machine"
        providerEntry={null}
        terminalProcessCount={2}
      />,
    );

    expect(markup).toContain("/projects/t3code");
    expect(markup).toContain("Build machine");
    expect(markup).toContain("2 terminal processes running");
    expect(markup).toContain("#273 PR merged: Separate projection reconciliation");
  });
});
