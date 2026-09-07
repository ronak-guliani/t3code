import "../../index.css";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../../uiStateStore";
import { CopilotCompletionWarning } from "./CopilotCompletionWarning";

const warning = (id: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  kind: "runtime.warning",
  tone: "info",
  summary: "Runtime warning",
  payload: { detail: { code: "copilot-acp-post-completion-activity" } },
  turnId: null,
  createdAt: "2026-09-06T00:00:00Z",
});

describe("CopilotCompletionWarning", () => {
  beforeEach(() => {
    useUiStateStore.setState({ dismissedCopilotWarningIds: new Set() });
  });

  it("surfaces late activity, dismisses only that warning, and shows a new runtime warning", async () => {
    const first = warning("first");
    const screen = await render(<CopilotCompletionWarning activities={[first]} />);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Review the session before sending");
    await expect.element(page.getByRole("alert")).toHaveTextContent("completion checkpoint");
    await page.getByRole("button", { name: "Dismiss Copilot completion warning" }).click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(<CopilotCompletionWarning activities={[first]} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(<CopilotCompletionWarning activities={[first, warning("second")]} />);
    await expect.element(page.getByRole("alert")).toBeVisible();
  });

  it("does not label other warnings or malformed payloads as Copilot completion uncertainty", async () => {
    await render(
      <CopilotCompletionWarning
        activities={[
          { ...warning("other"), payload: { detail: { code: "other-warning" } } },
          { ...warning("malformed"), payload: null },
          { ...warning("not-warning"), kind: "tool.completed" },
        ]}
      />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("retains independent dismissals across keyed thread remounts", async () => {
    const first = warning("thread-a-warning");
    const second = warning("thread-b-warning");
    const screen = await render(<CopilotCompletionWarning key="a" activities={[first]} />);
    await page.getByRole("button", { name: "Dismiss Copilot completion warning" }).click();
    await screen.rerender(<CopilotCompletionWarning key="b" activities={[second]} />);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss Copilot completion warning" }).click();
    await screen.rerender(<CopilotCompletionWarning key="a" activities={[first]} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(<CopilotCompletionWarning key="b" activities={[second]} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(
      <CopilotCompletionWarning key="a" activities={[first, warning("new-thread-a-warning")]} />,
    );
    await expect.element(page.getByRole("alert")).toBeVisible();
  });
});
