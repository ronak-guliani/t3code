import { describe, expect, it, vi } from "vite-plus/test";

import type { MarkdownCodeHighlighter } from "./SelectableMarkdownText.types";
import { createCodeHighlightLifecycle } from "./codeHighlightLifecycle";

const tokens = [[{ content: "code", color: null, fontStyle: null }]] as const;

function request(highlightCode: MarkdownCodeHighlighter, code = "code") {
  return { code, language: "ts", theme: "dark" as const, highlightCode };
}

describe("code highlight lifecycle", () => {
  it("coalesces consumers and only cancels after the final consumer releases", async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (value: typeof tokens) => void;
    const highlightCode = vi.fn(
      (input: Parameters<MarkdownCodeHighlighter>[0]) =>
        new Promise<typeof tokens>((done) => {
          signal = input.signal;
          resolve = done;
        }),
    );
    const lifecycle = createCodeHighlightLifecycle();

    const first = lifecycle.acquire(request(highlightCode));
    const second = lifecycle.acquire(request(highlightCode));
    first.release();
    await Promise.resolve();

    expect(highlightCode).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    resolve(tokens);
    await expect(second.promise).resolves.toBe(tokens);
    second.release();
  });

  it("cancels obsolete work and does not cache its late result", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: typeof tokens) => void> = [];
    const highlightCode = vi.fn(
      (input: Parameters<MarkdownCodeHighlighter>[0]) =>
        new Promise<typeof tokens>((resolve) => {
          signals.push(input.signal!);
          resolvers.push(resolve);
        }),
    );
    const lifecycle = createCodeHighlightLifecycle();

    const obsolete = lifecycle.acquire(request(highlightCode, "old"));
    obsolete.release();
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);

    resolvers[0]?.(tokens);
    await obsolete.promise;
    const retry = lifecycle.acquire(request(highlightCode, "old"));

    expect(highlightCode).toHaveBeenCalledTimes(2);
    retry.release();
  });

  it("restarts work when a remount follows an abort before the old request settles", async () => {
    const signals: AbortSignal[] = [];
    const highlightCode = vi.fn(
      (input: Parameters<MarkdownCodeHighlighter>[0]) =>
        new Promise<typeof tokens>(() => {
          signals.push(input.signal!);
        }),
    );
    const lifecycle = createCodeHighlightLifecycle();

    const obsolete = lifecycle.acquire(request(highlightCode));
    obsolete.release();
    await Promise.resolve();
    const remounted = lifecycle.acquire(request(highlightCode));

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    remounted.release();
  });

  it("reuses settled results without restarting highlighting", async () => {
    const highlightCode = vi.fn(async () => tokens);
    const lifecycle = createCodeHighlightLifecycle();
    const first = lifecycle.acquire(request(highlightCode));

    await expect(first.promise).resolves.toBe(tokens);
    first.release();
    const reused = lifecycle.acquire(request(highlightCode));

    await expect(reused.promise).resolves.toBe(tokens);
    expect(highlightCode).toHaveBeenCalledTimes(1);
  });

  it("keeps cache identity correct across language, theme, and highlighter changes", async () => {
    const firstHighlighter = vi.fn(async () => tokens);
    const secondHighlighter = vi.fn(async () => tokens);
    const lifecycle = createCodeHighlightLifecycle();

    await lifecycle.acquire(request(firstHighlighter)).promise;
    await lifecycle.acquire({
      ...request(firstHighlighter),
      language: "tsx",
    }).promise;
    await lifecycle.acquire({
      ...request(firstHighlighter),
      theme: "light",
    }).promise;
    await lifecycle.acquire(request(secondHighlighter)).promise;

    expect(firstHighlighter).toHaveBeenCalledTimes(3);
    expect(secondHighlighter).toHaveBeenCalledTimes(1);
  });

  it("evicts only the least-recently-used settled result", async () => {
    const highlightCode = vi.fn(async (_input: Parameters<MarkdownCodeHighlighter>[0]) => tokens);
    const lifecycle = createCodeHighlightLifecycle(2);
    const settle = async (code: string): Promise<void> => {
      const lease = lifecycle.acquire(request(highlightCode, code));
      await lease.promise;
      lease.release();
    };

    await settle("first");
    await settle("second");
    await settle("first");
    await settle("third");
    await settle("first");
    await settle("second");

    expect(highlightCode).toHaveBeenCalledTimes(4);
    expect(highlightCode.mock.calls.map(([input]) => input.code)).toEqual([
      "first",
      "second",
      "third",
      "second",
    ]);
  });
});
