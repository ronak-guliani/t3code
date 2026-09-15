import "../../index.css";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
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
  it("shows a badge and reveals details on hover", async () => {
    await render(<CopilotCompletionWarning activities={[warning("first")]} />);
    const badge = page.getByRole("alert");
    await expect.element(badge).toHaveTextContent("Copilot continued after completion");
    await expect.element(badge).not.toHaveTextContent("Review the session before sending");
    await badge.hover();
    await expect
      .element(page.getByText("Review the session before sending"))
      .toHaveTextContent("completion checkpoint");
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
});
