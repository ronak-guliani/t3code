import { MessageId, ThreadId } from "@t3tools/contracts";
import { createElement, useRef, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useChatFind, type ChatFindController } from "./useChatFind";

function messageRow(id: string, text: string): MessagesTimelineRow {
  const createdAt = "2026-10-01T00:00:00.000Z";
  return {
    kind: "message",
    id,
    createdAt,
    message: { id: MessageId.make(id), role: "user", text, createdAt, streaming: false },
    durationStart: createdAt,
    showCompletionDivider: false,
    showAssistantCopyButton: false,
    showAssistantTerminalMetadata: false,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("restores evicted search matches on a new non-empty query without reloading covered history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("window", {
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  });
  const fullHistory = [
    messageRow("old-user", "Lost historical phrase"),
    messageRow("recent-user", "Recent phrase"),
  ];
  let historyReads = 0;
  let controller: ChatFindController | undefined;
  let evict: (() => void) | undefined;
  function Search() {
    const [rows, setRows] = useState(fullHistory);
    const complete = useRef(true);
    const viewport = useRef<HTMLElement | null>(null);
    const list = useRef(null);
    evict = () => {
      complete.current = false;
      setRows(fullHistory.slice(1));
    };
    controller = useChatFind({
      timelineRows: rows,
      messagesViewportRef: viewport,
      legendListRef: list,
      routeThreadKey: "environment:thread",
      activeThreadId: ThreadId.make("thread"),
      onEnsureCompleteHistory: async () => {
        if (complete.current) return;
        historyReads++;
        complete.current = true;
        setRows(fullHistory);
      },
    });
    return createElement("output", null, controller.matches.map((match) => match.rowId).join(","));
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Search));
  });
  if (!renderer || !controller || !evict) throw new Error("Search did not mount");
  const view = renderer;
  try {
    await act(async () => controller?.openFind());
    await act(async () => controller?.setQuery("Absent phrase"));
    expect(view.root.findByType("output").children).toEqual([]);
    await act(async () => evict?.());
    expect(historyReads).toBe(0);
    await act(async () => controller?.setQuery("Lost historical phrase"));
    expect(view.root.findByType("output").children).toEqual(["old-user"]);
    expect(controller.loadingHistory).toBe(false);
    expect(historyReads).toBe(1);
    await act(async () => controller?.setQuery("Recent phrase"));
    expect(view.root.findByType("output").children).toEqual(["recent-user"]);
    expect(historyReads).toBe(1);
  } finally {
    await act(async () => view.unmount());
  }
});
