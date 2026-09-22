import "../../index.css";

import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Per-text render counts for the mocked markdown body. A settled row must not
// re-render its markdown when a later streaming chunk only changes the active
// row and the streaming context identity.
const markdownRenders = new Map<string, number>();
// Calls to the per-row copy-state derivation, keyed by message text. It runs
// inside the assistant row body, so settled rows must not re-invoke it on
// later chunks even though the streaming context identity changes.
const copyStateCalls = new Map<string, number>();

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
      </div>
    );
  });

  return { LegendList };
});

vi.mock("../ChatMarkdown", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("../ChatMarkdown")>();
  return {
    ...actual,
    default: React.memo(function MockChatMarkdown(props: { text: string }) {
      markdownRenders.set(props.text, (markdownRenders.get(props.text) ?? 0) + 1);
      return <div>{props.text}</div>;
    }),
  };
});

vi.mock("./MessagesTimeline.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessagesTimeline.logic")>();
  return {
    ...actual,
    resolveAssistantMessageCopyState: (
      input: Parameters<typeof actual.resolveAssistantMessageCopyState>[0],
    ) => {
      const text = input.text ?? "(null)";
      copyStateCalls.set(text, (copyStateCalls.get(text) ?? 0) + 1);
      return actual.resolveAssistantMessageCopyState(input);
    },
  };
});

import { MessagesTimeline } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const CREATED_AT = "2026-09-15T12:00:00.000Z";
const TURN_SETTLED = TurnId.make("turn-streaming-perf-settled");
const TURN_ACTIVE = TurnId.make("turn-streaming-perf-active");
// Shared entry identity across chunks: only the active turn's entry is
// replaced per chunk, so settled rows must resolve stable props.
const SETTLED_META = { model: "mock-model", usedTokens: 100 };

function buildProps() {
  return {
    isWorking: true,
    activeTurnInProgress: true,
    activeTurnId: TURN_ACTIVE,
    activeTurnStartedAt: CREATED_AT,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    copilotResumeCommand: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    activeThreadId: ThreadId.make("thread-1"),
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

function buildAssistantRow(
  id: string,
  messageId: string,
  turnId: TurnId,
  text: string,
  streaming: boolean,
): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    kind: "message",
    id,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(messageId),
      role: "assistant",
      text,
      turnId,
      createdAt: CREATED_AT,
      completedAt: streaming ? undefined : CREATED_AT,
      streaming,
    },
    durationStart: CREATED_AT,
    showCompletionDivider: false,
    showAssistantCopyButton: false,
    showAssistantTerminalMetadata: true,
  };
}

describe("MessagesTimeline streaming invalidation", () => {
  it("does not re-render settled assistant rows on streaming chunks", async () => {
    markdownRenders.clear();
    copyStateCalls.clear();
    const props = buildProps();
    const settledRow = buildAssistantRow(
      "row-settled",
      "message-settled",
      TURN_SETTLED,
      "Settled answer",
      false,
    );
    const activeV1 = buildAssistantRow(
      "row-active",
      "message-active",
      TURN_ACTIVE,
      "streaming chunk one",
      true,
    );
    const screen = await render(
      <MessagesTimeline
        {...props}
        responseMetaByTurnId={
          new Map([
            [TURN_SETTLED, SETTLED_META],
            [TURN_ACTIVE, { model: "mock-model", usedTokens: 1 }],
          ])
        }
        timelineEntries={[]}
        rows={[settledRow, activeV1]}
      />,
    );

    try {
      await expect.element(page.getByText("Settled answer", { exact: true })).toBeVisible();
      expect(markdownRenders.get("Settled answer")).toBe(1);

      const activeV2: typeof activeV1 = {
        ...activeV1,
        message: { ...activeV1.message, text: "streaming chunk one two" },
      };
      await screen.rerender(
        <MessagesTimeline
          {...props}
          responseMetaByTurnId={
            new Map([
              [TURN_SETTLED, SETTLED_META],
              [TURN_ACTIVE, { model: "mock-model", usedTokens: 2 }],
            ])
          }
          timelineEntries={[]}
          rows={[settledRow, activeV2]}
        />,
      );

      await expect
        .element(page.getByText("streaming chunk one two", { exact: true }))
        .toBeVisible();
      // New streaming-context identity invalidated subscribers, but the
      // settled row's projected slice is referentially stable, so its
      // memoized markdown subtree must not have rendered again.
      expect(markdownRenders.get("Settled answer")).toBe(1);
      // The settled row body itself must not have re-run either: only the
      // active row's presentational subtree derives copy state per chunk.
      expect(copyStateCalls.get("Settled answer")).toBe(1);

      // Settle the turn: streaming-context identity changes again (liveness
      // flips), but the settled row's slice is unchanged and must bail out.
      const activeV3: typeof activeV1 = {
        ...activeV1,
        message: {
          ...activeV1.message,
          text: "settled final text",
          streaming: false,
          completedAt: CREATED_AT,
        },
      };
      await screen.rerender(
        <MessagesTimeline
          {...props}
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnId={null}
          responseMetaByTurnId={new Map([[TURN_SETTLED, SETTLED_META]])}
          timelineEntries={[]}
          rows={[settledRow, activeV3]}
        />,
      );

      await expect.element(page.getByText("settled final text", { exact: true })).toBeVisible();
      expect(markdownRenders.get("Settled answer")).toBe(1);
      expect(copyStateCalls.get("Settled answer")).toBe(1);
    } finally {
      await screen.unmount();
    }
  });
});
