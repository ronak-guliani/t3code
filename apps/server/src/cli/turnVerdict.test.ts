import {
  EventId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import { explainTurn } from "./turnVerdict.ts";

const turnId = TurnId.make("turn-1");

function latestTurn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId,
    state,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:09.000Z",
    assistantMessageId: null,
  };
}

function turnCompleted(
  payload: Record<string, unknown>,
  overrides?: { readonly id?: string },
): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides?.id ?? "evt-1"),
    tone: "info",
    kind: "insights.turn.completed",
    summary: "Turn completed",
    payload,
    turnId,
    createdAt: "2026-01-01T00:00:09.000Z",
  };
}

function toolActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("evt-tool"),
    tone: "info",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { itemType: "command_execution" },
    turnId,
    createdAt: "2026-01-01T00:00:05.000Z",
  };
}

function explain(payload: Record<string, unknown> | null) {
  return explainTurn({
    latestTurn: latestTurn("completed"),
    activities: [toolActivity(), ...(payload === null ? [] : [turnCompleted(payload)])],
  }).join("\n");
}

describe("explainTurn", () => {
  it("reports a completed reply", () => {
    assert.match(
      explain({
        stopReason: "end_turn",
        assistantTextObserved: true,
        assistantMessagePersisted: true,
      }),
      /Turn: completed \(turn turn-1\)/,
    );
    assert.match(
      explain({
        stopReason: "end_turn",
        assistantTextObserved: true,
        assistantMessagePersisted: true,
      }),
      /Provider completion: end_turn/,
    );
    assert.match(
      explain({
        stopReason: "end_turn",
        assistantTextObserved: true,
        assistantMessagePersisted: true,
      }),
      /Reply delivery: complete/,
    );
  });

  it("reports incomplete delivery when provider text was never persisted", () => {
    const output = explain({
      stopReason: "end_turn",
      assistantTextObserved: true,
      assistantMessagePersisted: false,
    });
    assert.match(output, /Provider assistant text: observed/);
    assert.match(output, /Persisted assistant message: absent/);
    assert.match(output, /Reply delivery: incomplete/);
  });

  it("does not flag a tool-only turn that legitimately has no reply", () => {
    const output = explain({
      stopReason: "end_turn",
      assistantTextObserved: false,
      assistantMessagePersisted: false,
    });
    assert.match(output, /Provider assistant text: not observed/);
    assert.match(output, /Persisted assistant message: absent/);
    assert.match(output, /Reply delivery: not expected/);
    assert.notMatch(output, /incomplete/);
  });

  it("treats an absent stop reason as unreported rather than failed", () => {
    const output = explain({ assistantTextObserved: true, assistantMessagePersisted: true });
    assert.match(output, /Provider completion: not reported by this provider/);
    assert.match(output, /Reply delivery: complete/);
  });

  it("reports unknown when the page has no completion evidence", () => {
    assert.match(explain(null), /Reply delivery: unknown/);
    assert.match(explain({}), /Reply delivery: unknown/);
    assert.match(explain(null), /No insights\.turn\.completed activity/);
  });

  // Activity pages come back newest-first, as `chat show --activities` returns them.
  it("prefers the newest completion activity in the page", () => {
    const output = explainTurn({
      latestTurn: latestTurn("completed"),
      activities: [
        turnCompleted(
          {
            stopReason: "refusal",
            assistantTextObserved: true,
            assistantMessagePersisted: false,
          },
          { id: "evt-new" },
        ),
        turnCompleted(
          {
            stopReason: "max_tokens",
            assistantTextObserved: true,
            assistantMessagePersisted: true,
          },
          { id: "evt-old" },
        ),
      ],
    }).join("\n");
    assert.match(output, /Provider completion: refusal/);
    assert.match(output, /Reply delivery: incomplete/);
  });
});
