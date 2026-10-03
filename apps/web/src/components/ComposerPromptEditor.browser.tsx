import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useRef, useState } from "react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

it("does not commit or interrupt controlled input when Enter resolves an IME composition", async () => {
  const onCommandKeyDown = vi.fn(() => true);
  const onParentKeyDown = vi.fn();

  function Harness() {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);

    return (
      <div onKeyDown={onParentKeyDown}>
        <ComposerPromptEditor
          value={value}
          cursor={cursor}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Prompt"
          onRemoveTerminalContext={vi.fn()}
          onChange={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onCommandKeyDown={onCommandKeyDown}
          onPaste={vi.fn()}
        />
      </div>
    );
  }

  const screen = await render(<Harness />);

  try {
    const editor = page.getByTestId("composer-editor");
    const element = await editor.element();
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await editor.fill("に");

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    element.dispatchEvent(enter);

    expect(onCommandKeyDown).not.toHaveBeenCalled();
    expect(onParentKeyDown).not.toHaveBeenCalled();
    await expect.element(editor).toHaveTextContent("に");

    element.dispatchEvent(new CompositionEvent("compositionend", { data: "に", bubbles: true }));
    await expect.element(editor).toHaveTextContent("に");
  } finally {
    await screen.unmount();
  }
});

it("renders thread references as inline chips with text-only keyboard deletion", async () => {
  const { EnvironmentId, ThreadContextId, ThreadId } = await import("@t3tools/contracts");
  const onRemoveThreadContext = vi.fn();
  const onChange = vi.fn();
  const environmentId = EnvironmentId.make("env-browser");
  const contextId = ThreadContextId.make("ctx-browser-1");
  const record = {
    version: 1 as const,
    kind: "thread" as const,
    contextId,
    label: "Browser thread",
    environmentId,
    threadId: ThreadId.make("thread-browser-1"),
    title: "Stored thread title",
  };

  function Harness() {
    const [value, setValue] = useState(
      `see ok [Browser thread](t3-context://v1/thread/${contextId}) `,
    );
    const [cursor, setCursor] = useState(0);
    const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

    return (
      <>
        <button type="button" onClick={() => editorRef.current?.focusAtEnd()}>
          focus-end
        </button>
        <ComposerPromptEditor
          ref={editorRef}
          value={value}
          cursor={cursor}
          terminalContexts={[]}
          threadContexts={[record]}
          threadContextTitles={new Map([[contextId, "Live thread title"]])}
          skills={[]}
          disabled={false}
          placeholder="Prompt"
          onRemoveTerminalContext={vi.fn()}
          onRemoveThreadContext={onRemoveThreadContext}
          onChange={(nextValue, nextCursor) => {
            onChange(nextValue);
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onPaste={vi.fn()}
        />
      </>
    );
  }

  const screen = await render(<Harness />);
  try {
    const editor = page.getByTestId("composer-editor");
    // The reference renders as an inline named chip, not raw markdown.
    await expect.element(editor).toHaveTextContent("Live thread title");
    const chip = page.getByTitle("Live thread title");
    await expect.element(chip).toBeInTheDocument();

    // The chip × button removes explicitly through the binding callback.
    const remove = page.getByRole("button", { name: "Remove Live thread title" });
    await remove.click();
    await vi.waitFor(() => {
      expect(onRemoveThreadContext).toHaveBeenCalledTimes(1);
    });
    expect(onRemoveThreadContext).toHaveBeenCalledWith(contextId);

    // Backspace on the chip removes its text but never the stored binding.
    await page.getByText("focus-end").click();
    const element = await editor.element();
    const backspace = () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    backspace();
    backspace();
    await vi.waitFor(() => {
      expect(onChange.mock.calls.some(([text]) => !String(text).includes("t3-context://"))).toBe(
        true,
      );
    });
    expect(onRemoveThreadContext).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});
