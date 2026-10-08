import "../../index.css";

import {
  MessageId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationQueuedTurn,
} from "@t3tools/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

const feedback: OrchestrationQueuedTurn = {
  id: QueuedTurnId.make("feedback"),
  threadId: ThreadId.make("queue-thread"),
  message: {
    messageId: MessageId.make("feedback-message"),
    role: "user",
    text: "Review feedback",
    attachments: [],
  },
  origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  failedAt: null,
  failureMessage: null,
};

// Paused feedback must explain its blocker; a user message behind it must stay
// eligible, and resuming must restore the actual first eligible queue row.
function QueueFixture() {
  const [paused, setPaused] = useState(true);
  return (
    <>
      <button onClick={() => setPaused(false)}>Resume child follow-up</button>
      <QueuedMessagesPanel
        queuedTurns={[
          feedback,
          {
            ...feedback,
            id: QueuedTurnId.make("user"),
            origin: undefined,
            message: {
              ...feedback.message,
              messageId: MessageId.make("user-message"),
              text: "User follow-up",
            },
          },
        ]}
        automaticFollowUpPaused={paused}
        queueHeldAt={null}
        editingQueuedTurnId={null}
        editingText=""
        onCancelEditingQueuedTurn={() => {}}
        onSaveEditingQueuedTurn={() => {}}
        onDeleteQueuedTurn={() => {}}
        onMoveQueuedTurn={() => {}}
        onReleaseQueue={() => {}}
      />
    </>
  );
}

it("keeps paused PR feedback pending without blocking user work and clears the reason on resume", async () => {
  const mounted = await render(<QueueFixture />);
  try {
    await expect.element(page.getByText("Pending", { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Automatic follow-up is paused. Resume child follow-up to send this PR feedback.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("User follow-up", { exact: true }).element().closest("li")!)
      .toHaveTextContent("Up next");
    await page.getByRole("button", { name: "Resume child follow-up" }).click();
    await expect.element(page.getByText("Pending", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Review feedback", { exact: true }).element().closest("li")!)
      .toHaveTextContent("Up next");
  } finally {
    await mounted.unmount();
  }
});
