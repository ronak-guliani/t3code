import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { SidebarThreadEnvironmentIcon } from "./SidebarThreadEnvironmentIcon";
import { SidebarV2NestedRow } from "./SidebarV2NestedRow";
import { SidebarV2Row, type SidebarV2RowProps } from "./SidebarV2Row";
import { useThreadEnvironmentLabel } from "./SidebarV2ThreadTooltip";

const environments = vi.hoisted(() => ({
  primaryId: "local-environment" as string | null,
  runtimeLabel: "Build machine" as string | null,
  savedLabel: "Saved machine" as string | null,
}));

vi.mock("../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/primary")>()),
  usePrimaryEnvironmentId: () => environments.primaryId,
}));

vi.mock("../environments/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/runtime")>()),
  useSavedEnvironmentRuntimeStore: (selector: (state: unknown) => unknown) =>
    selector({
      byId: { "remote-environment": { descriptor: { label: environments.runtimeLabel } } },
    }),
  useSavedEnvironmentRegistryStore: (selector: (state: unknown) => unknown) =>
    selector({
      byId: { "remote-environment": { label: environments.savedLabel } },
    }),
}));

vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./ThreadStatusIndicators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadStatusIndicators")>()),
  ThreadBrowserOpenStatus: () => null,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipPopup: () => null,
}));

const thread: SidebarThreadSummary = {
  id: ThreadId.make("device-thread"),
  environmentId: EnvironmentId.make("remote-environment"),
  projectId: ProjectId.make("device-project"),
  parentThreadId: null,
  title: "Keep thread titles clean",
  interactionMode: "default",
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  pullRequest: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasPendingQueuedTurn: false,
};

function EnvironmentMarker() {
  const { environmentLabel } = useThreadEnvironmentLabel(thread);
  return <SidebarThreadEnvironmentIcon environmentLabel={environmentLabel} />;
}

const noop = () => {};
const rowProps: SidebarV2RowProps = {
  thread,
  projectName: "t3code",
  projectCwd: null,
  variant: "card",
  active: false,
  pinned: false,
  snoozed: false,
  settled: false,
  settleBlocked: false,
  snoozeBlocked: false,
  settlementSupported: true,
  snoozeSupported: true,
  providerEntry: null,
  displayStatus: "ready",
  hasChildren: false,
  isExpanded: false,
  childCount: 0,
  onToggleExpanded: noop,
  onDismissAgentRun: noop,
  onOpen: noop,
  onSetPinned: noop,
  onSettle: noop,
  onUnsettle: noop,
  onSnooze: noop,
  onUnsnooze: noop,
};

describe("sidebar environment presentation", () => {
  beforeEach(() => {
    environments.primaryId = "local-environment";
    environments.runtimeLabel = "Build machine";
    environments.savedLabel = "Saved machine";
  });

  it("hides the marker for this machine", () => {
    environments.primaryId = thread.environmentId;
    expect(renderToStaticMarkup(<EnvironmentMarker />)).toBe("");
  });

  it("shows only an accessible icon with the readable device name on hover", () => {
    const markup = renderToStaticMarkup(<EnvironmentMarker />);
    expect(markup).toContain('aria-label="Execution environment: Build machine"');
    expect(markup).toContain('title="Build machine"');
    expect(markup.replace(/<[^>]*>/g, "")).toBe("");
    expect(markup).not.toContain(thread.environmentId.slice(0, 6));
  });

  it("identifies all machines in a hosted client with no primary environment", () => {
    environments.primaryId = null;
    expect(renderToStaticMarkup(<EnvironmentMarker />)).toContain('role="img"');
  });

  it("uses the saved label while disconnected and a readable fallback when unavailable", () => {
    environments.runtimeLabel = null;
    expect(renderToStaticMarkup(<EnvironmentMarker />)).toContain('title="Saved machine"');
    environments.savedLabel = null;
    expect(renderToStaticMarkup(<EnvironmentMarker />)).toContain('title="Remote"');
  });

  it.each(["card", "slim", "nested"] as const)(
    "renders exactly one remote icon and no inline environment text in %s rows",
    (variant) => {
      const renderRow = () =>
        renderToStaticMarkup(
          variant === "nested" ? (
            <SidebarV2NestedRow {...rowProps} depth={1} archiveBlocked={false} onArchive={noop} />
          ) : (
            <SidebarV2Row {...rowProps} variant={variant} />
          ),
        );
      const markup = renderRow();
      expect(markup.match(/aria-label="Execution environment:/g)).toHaveLength(1);
      const visibleText = markup.replace(/<[^>]*>/g, "");
      expect(visibleText).toContain(thread.title);
      expect(visibleText).not.toContain("Build machine");
      expect(visibleText).not.toContain(thread.environmentId.slice(0, 6));

      environments.primaryId = thread.environmentId;
      expect(renderRow()).not.toContain('aria-label="Execution environment:');
    },
  );
});
