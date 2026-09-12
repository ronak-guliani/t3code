import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChildNudgeUpdate,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Thread, ThreadShell } from "../../types";

const fixture = vi.hoisted(() => ({
  children: [] as ThreadShell[],
  dispatch: vi.fn<(command: ClientOrchestrationCommand) => Promise<unknown>>(),
  navigate: vi.fn(),
}));
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand: fixture.dispatch } }),
}));

import { ChildFollowUpPanel, ChildFollowUpReceipt } from "./ChildFollowUpPanel";

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
  id: "decision-1",
  childThreadId: ThreadId.make("child"),
  childTitle: "Migration helper",
  assignmentId: MessageId.make("assignment-1"),
  kind: "decision-needed",
  summary: "A migration decision is needed.",
  decision: { question: "Expand or replace?", options: ["Expand", "Replace"] },
  canContinue: false,
};
const child: ThreadShell = {
  ...parent,
  id: report.childThreadId,
  parentThreadId: parent.id,
  title: report.childTitle,
  nudging: {
    delegation: {
      assignmentId: report.assignmentId,
      followUp: "automatic",
      completedAt: null,
      decision: report,
    },
  },
};

describe("Child follow-up interactions", () => {
  beforeEach(() => {
    fixture.children = [child];
    fixture.dispatch.mockReset().mockResolvedValue({});
    fixture.navigate.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("queues an attributed decision response and retries the same durable command on failure", async () => {
    fixture.dispatch.mockRejectedValueOnce(new Error("Connection lost"));
    const onError = vi.fn();
    await render(
      <ChildFollowUpPanel thread={parent} queuedTurns={[]} isWorking={false} onError={onError} />,
    );
    await page
      .getByRole("button", { name: "Decision needed · Migration helper", exact: true })
      .click();
    await expect.element(page.getByText("Expand or replace?")).toBeVisible();
    await page.getByRole("button", { name: "Respond to Migration helper" }).click();
    await page
      .getByRole("textbox", { name: "Response to Migration helper" })
      .fill("Expand the schema.");
    await page
      .getByRole("button", { name: "Decision needed · Migration helper", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Decision needed · Migration helper", exact: true })
      .click();
    await expect
      .element(page.getByRole("textbox", { name: "Response to Migration helper" }))
      .toHaveValue("Expand the schema.");
    await page.getByRole("button", { name: "Send response", exact: true }).click();
    await expect.poll(() => onError.mock.calls).toContainEqual([parent.id, "Connection lost"]);
    await expect
      .element(page.getByRole("textbox", { name: "Response to Migration helper" }))
      .toHaveValue("Expand the schema.");
    await page.getByRole("button", { name: "Send response", exact: true }).click();
    expect(fixture.dispatch.mock.calls).toHaveLength(2);
    expect(fixture.dispatch.mock.calls[1]![0]).toEqual(fixture.dispatch.mock.calls[0]![0]);
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.queued-turn.create",
      threadId: child.id,
      assignmentId: report.assignmentId,
      respondToReportId: report.id,
      message: { role: "user", text: "Expand the schema." },
    });
    await expect
      .element(page.getByRole("button", { name: "Respond to Migration helper" }))
      .toBeVisible();
  });

  it("offers Resume with no queue and while the parent is awaiting input", async () => {
    fixture.children = [];
    await render(
      <ChildFollowUpPanel
        thread={{ ...parent, nudging: { paused: true } }}
        queuedTurns={[]}
        isWorking={false}
        blockedByInteraction
        onError={vi.fn()}
      />,
    );
    await page.getByRole("button", { name: "Child follow-up controls" }).click();
    await page.getByRole("menuitem", { name: "Resume child follow-up" }).click();
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.meta.update",
      threadId: parent.id,
      childFollowUpPaused: false,
    });
  });

  it("saves explicit wait membership rather than including children implicitly", async () => {
    await render(
      <ChildFollowUpPanel thread={parent} queuedTurns={[]} isWorking={false} onError={vi.fn()} />,
    );
    await page.getByRole("button", { name: "Child follow-up controls" }).click();
    await page.getByRole("menuitem", { name: "Wait for selected children..." }).click();
    await page.getByRole("radio", { name: "Any selected" }).click();
    await page.getByRole("button", { name: "Save wait condition" }).click();
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.meta.update",
      childWait: {
        mode: "any",
        assignments: [{ childThreadId: child.id, assignmentId: report.assignmentId }],
      },
    });
  });

  it("opens receipt details without a user bubble or shimmer and retains disclosure after remount", async () => {
    let expanded = false;
    const screen = await render(
      <ChildFollowUpReceipt
        updates={[report]}
        environmentId={parent.environmentId}
        onExpandedChange={(value) => {
          expanded = value;
        }}
      />,
    );
    await expect.element(page.getByText("Expand or replace?")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Continued with 1 child update" }).click();
    await expect.element(page.getByText("Expand or replace?")).toBeVisible();
    expect(expanded).toBe(true);
    await screen.unmount();
    await render(
      <ChildFollowUpReceipt
        updates={[report]}
        environmentId={parent.environmentId}
        initialExpanded={expanded}
      />,
    );
    await expect.element(page.getByText("Expand or replace?")).toBeVisible();
    expect(document.querySelector(".work-activity-shimmer")).toBeNull();
    await page.getByRole("button", { name: "Migration helper Decision needed" }).click();
    expect(fixture.navigate.mock.calls[0]![0]).toMatchObject({
      params: { environmentId: parent.environmentId, threadId: child.id },
    });
  });
});
