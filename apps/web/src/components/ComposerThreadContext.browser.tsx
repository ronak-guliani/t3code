import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  ThreadContextId,
  ThreadId,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { formatThreadContextReference } from "@t3tools/shared/threadContext";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import {
  THREAD_CONTEXT_CLIPBOARD_MIME,
  parseThreadContextClipboardPayload,
} from "~/threadContextAttach";

const record: ThreadContextRecord = {
  version: 1,
  kind: "thread",
  contextId: ThreadContextId.make("editor_reference"),
  environmentId: EnvironmentId.make("editor_environment"),
  threadId: ThreadId.make("reference_thread"),
  label: "Login reference",
  title: "Login reference",
};
const reference = formatThreadContextReference(record);
const modifier = navigator.platform.toLowerCase().includes("mac") ? "Meta" : "Control";

// Exercise the production Lexical editor: references must be atomic, native undo
// must retain their identity, and clipboard events must carry actual selected records.
it("renders an atomic thread chip and restores it with native undo", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  function Harness() {
    const [value, setValue] = useState(`${reference} `);
    const [cursor, setCursor] = useState(2);
    return (
      <ComposerPromptEditor
        ref={ref}
        value={value}
        cursor={cursor}
        terminalContexts={[]}
        threadContexts={[record]}
        skills={[]}
        disabled={false}
        placeholder="Prompt"
        onRemoveTerminalContext={vi.fn()}
        onPaste={vi.fn()}
        onChange={(next, at) => {
          setValue(next);
          setCursor(at);
        }}
      />
    );
  }
  const screen = await render(<Harness />);
  try {
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Login reference");
    expect(
      document.querySelector(`[data-thread-context-chip="${record.contextId}"]`),
    ).not.toBeNull();
    ref.current!.focusAtEnd();
    await userEvent.keyboard("{Backspace}{Backspace}");
    await expect.poll(() => ref.current!.readSnapshot().value).toBe("");
    await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
    await expect.poll(() => ref.current!.readSnapshot().value).toContain(reference);
  } finally {
    await screen.unmount();
  }
});

it("does not navigate when clicking a thread chip inside the composer", async () => {
  const screen = await render(
    <ComposerPromptEditor
      value={`${reference} `}
      cursor={2}
      terminalContexts={[]}
      threadContexts={[record]}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onRemoveTerminalContext={vi.fn()}
      onPaste={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  const locationBefore = window.location.href;
  try {
    await userEvent.click(
      document.querySelector(`[data-thread-context-chip="${record.contextId}"]`)!,
    );
    expect(window.location.href).toBe(locationBefore);
    expect(
      document.querySelector(`[data-thread-context-chip="${record.contextId}"]`),
    ).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("copies selected thread context as structured clipboard data", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  const screen = await render(
    <ComposerPromptEditor
      ref={ref}
      value={`${reference} `}
      cursor={2}
      terminalContexts={[]}
      threadContexts={[record]}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onRemoveTerminalContext={vi.fn()}
      onPaste={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  try {
    ref.current!.focusAtEnd();
    await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
    const clipboard = new DataTransfer();
    const event = new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    });
    page.getByTestId("composer-editor").element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.getData("text/plain")).toContain(record.label);
    expect(clipboard.getData("text/plain")).not.toContain("t3-context://");
    expect(clipboard.getData("text/html")).not.toContain("#" + record.title);
    expect(
      parseThreadContextClipboardPayload(clipboard.getData(THREAD_CONTEXT_CLIPBOARD_MIME)),
    ).toEqual([record]);
  } finally {
    await screen.unmount();
  }
});

it("pastes the exact private prompt text in preference to readable plain text", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  const onThreadContextPaste = vi.fn();
  const screen = await render(
    <ComposerPromptEditor
      ref={ref}
      value=""
      cursor={0}
      terminalContexts={[]}
      threadContexts={[record]}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onRemoveTerminalContext={vi.fn()}
      onPaste={vi.fn()}
      onChange={vi.fn()}
      onThreadContextPaste={onThreadContextPaste}
    />,
  );
  try {
    ref.current!.focusAtEnd();
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", record.label);
    clipboard.setData(
      THREAD_CONTEXT_CLIPBOARD_MIME,
      JSON.stringify({ version: 1, records: [record], text: reference }),
    );
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    });
    page.getByTestId("composer-editor").element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onThreadContextPaste).toHaveBeenCalledWith(reference, [record], expect.any(Object));
  } finally {
    await screen.unmount();
  }
});
