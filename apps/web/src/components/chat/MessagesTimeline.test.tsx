import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const ACTIVE_THREAD_ID = ThreadId.make("thread-1");

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
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
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    activeThreadId: ACTIVE_THREAD_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

describe("MessagesTimeline", () => {
  it("highlights matching substrings in open chat search results", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        chatFindQuery="needle"
        matchedRowIds={new Set(["entry-1", "entry-2"])}
        activeMatchRowId="entry-1"
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-user"),
              role: "user",
              text: "Needle alpha",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.make("message-assistant"),
              role: "assistant",
              text: "Found another needle in markdown.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("<mark");
    expect(markup).toContain(">Needle</mark>");
    expect(markup).toContain(">needle</mark>");
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("collapses completed tool-call groups to an expandable header", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              isComplete: true,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Tool calls (2)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Expand");
    expect(markup).not.toContain("Read file");
    expect(markup).not.toContain("Ran command");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders the Copilot resume command only in terminal assistant message metadata", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const copilotResumeCommand = "copilot --resume=a7f0c803-7cce-4554-9ad6-dfd9df539e33";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        copilotResumeCommand={copilotResumeCommand}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: MessageId.make("message-assistant-1"),
              role: "assistant",
              text: "I am checking this.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:01:00.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
          {
            id: "entry-2",
            kind: "message",
            createdAt: "2026-04-22T19:03:33.000Z",
            message: {
              id: MessageId.make("message-assistant-2"),
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:03:33.000Z",
              completedAt: "2026-04-22T19:03:40.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup.match(new RegExp(`>${copilotResumeCommand}</span>`, "g"))).toHaveLength(1);
    expect(markup.indexOf(copilotResumeCommand)).toBeGreaterThan(markup.indexOf("All set."));
  });

  it("renders turn-scoped changed files by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const { useUiStateStore } = await import("../../uiStateStore");
    useUiStateStore.setState({ changedFilesDiffScope: "turn" });
    const assistantMessageId = MessageId.make("message-assistant");
    const turnId = TurnId.make("turn-1");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:03:33.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                completedAt: "2026-04-22T19:03:33.000Z",
                files: [
                  { path: "src/plan.md", additions: 5, deletions: 1 },
                  { path: "src/unrelated.ts", additions: 10, deletions: 0 },
                ],
                turnFiles: [{ path: "src/plan.md", additions: 5, deletions: 1 }],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("Changed files (Turn) (1)");
    expect(markup).toContain("plan.md");
    expect(markup).not.toContain("unrelated.ts");
  });

  it("renders explicit empty-turn state without falling back to snapshot", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const { useUiStateStore } = await import("../../uiStateStore");
    useUiStateStore.setState({ changedFilesDiffScope: "turn" });
    const assistantMessageId = MessageId.make("message-assistant");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:03:33.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.make("turn-1"),
                completedAt: "2026-04-22T19:03:33.000Z",
                files: [{ path: "src/snapshot.ts", additions: 2, deletions: 0 }],
                turnFiles: [],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("Changed files (Turn) (0)");
    expect(markup).toContain("No turn-scoped file changes detected");
    expect(markup).not.toContain("snapshot.ts");
    expect(markup).toMatch(/disabled=""[^<]*>View diff/);
  });
});
