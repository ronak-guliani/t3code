import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  type ChildNudgeUpdate,
  type OrchestrationQueuedTurn,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, ThreadShell } from "../../types";
import { ChildFollowUpPanel, ChildFollowUpReceipt } from "./ChildFollowUpPanel";

const fixture = vi.hoisted(() => ({ children: [] as ThreadShell[] }));
vi.mock("../../store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      environmentStateById: {
        local: {
          threadIdsByProjectId: { project: fixture.children.map((child) => child.id) },
          threadShellById: Object.fromEntries(fixture.children.map((child) => [child.id, child])),
        },
      },
    }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../environmentApi", () => ({ readEnvironmentApi: () => undefined }));

const parent: Thread = {
  id: ThreadId.make("parent"),
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  parentThreadId: null,
  title: "Parent",
  codexThreadId: null,
  modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test" },
  runtimeMode: "full-access",
  pendingRuntimeMode: null,
  interactionMode: "default",
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
};
const report: ChildNudgeUpdate = {
  id: "report",
  childThreadId: ThreadId.make("child"),
  childTitle: "Migration helper",
  assignmentId: MessageId.make("assignment"),
  kind: "result-available",
  summary: "Literal <terminal_context>example</terminal_context>",
};
const nudge: OrchestrationQueuedTurn = {
  id: QueuedTurnId.make("nudge"),
  threadId: parent.id,
  message: {
    messageId: MessageId.make("nudge"),
    role: "user",
    text: "Internal wake instructions",
    attachments: [],
  },
  runtimeMode: parent.runtimeMode,
  interactionMode: parent.interactionMode,
  origin: { kind: "child-nudge", updates: [report] },
  createdAt: parent.createdAt,
  updatedAt: parent.createdAt,
  failedAt: null,
  failureMessage: null,
};
const child: ThreadShell = {
  ...parent,
  id: report.childThreadId,
  parentThreadId: parent.id,
  title: report.childTitle,
  nudging: {
    delegation: { assignmentId: report.assignmentId, followUp: "automatic", completedAt: null },
  },
};

describe("child follow-up presentation", () => {
  beforeEach(() => {
    fixture.children = [];
  });

  it("keeps pause controls reachable with an empty queue", () => {
    const html = renderToStaticMarkup(
      <ChildFollowUpPanel
        thread={{ ...parent, nudging: { paused: true } }}
        queuedTurns={[]}
        isWorking={false}
        onError={vi.fn()}
      />,
    );
    expect(html).toContain("Child follow-up paused");
    expect(html).toContain("Child follow-up controls");
    expect(html).not.toContain("work-activity-shimmer");
  });

  it("shows active assignments before any update has been queued", () => {
    fixture.children = [child];
    const html = renderToStaticMarkup(
      <ChildFollowUpPanel thread={parent} queuedTurns={[]} isWorking={false} onError={vi.fn()} />,
    );
    expect(html).toContain("1 child working");
    expect(html).not.toContain("work-activity-shimmer");
  });

  it("explains an explicit wait without changing parent execution status", () => {
    fixture.children = [child];
    const html = renderToStaticMarkup(
      <ChildFollowUpPanel
        thread={{
          ...parent,
          nudging: {
            wait: {
              mode: "all",
              assignments: [{ childThreadId: child.id, assignmentId: report.assignmentId }],
            },
          },
        }}
        queuedTurns={[nudge]}
        isWorking={false}
        onError={vi.fn()}
      />,
    );
    expect(html).toContain("Waiting for 1 child");
    expect(html).not.toContain("Internal wake instructions");
  });

  it("keeps delivered-but-unresolved decisions visible", () => {
    fixture.children = [
      {
        ...child,
        nudging: {
          delegation: {
            ...child.nudging!.delegation!,
            decision: { ...report, kind: "decision-needed", decision: { question: "A or B?" } },
          },
        },
      },
    ];
    const html = renderToStaticMarkup(
      <ChildFollowUpPanel thread={parent} queuedTurns={[]} isWorking={false} onError={vi.fn()} />,
    );
    expect(html).toContain("Decision needed");
    expect(html).toContain("Migration helper");
  });

  it("collapses historical reports by default and renders literal details when expanded", () => {
    const collapsed = renderToStaticMarkup(
      <ChildFollowUpReceipt updates={[report]} environmentId={parent.environmentId} />,
    );
    expect(collapsed).toContain("Continued with 1 child update");
    expect(collapsed).not.toContain("Migration helper");
    expect(collapsed).not.toContain("rounded-2xl");
    const expanded = renderToStaticMarkup(
      <ChildFollowUpReceipt
        updates={[report]}
        environmentId={parent.environmentId}
        forceExpanded
      />,
    );
    expect(expanded).toContain("Migration helper");
    expect(expanded).toContain("&lt;terminal_context&gt;");
    expect(expanded).not.toContain("lucide-terminal");
  });
});
