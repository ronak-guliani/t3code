import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const onError = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
      onError,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<void>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const onPendingChange = vi.fn();
    const onError = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
      onError,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("flushes an unsaved edit on disposal without replaying a completed write", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onError: vi.fn(),
    });
    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("second");
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist.mock.calls).toEqual([["first"], ["second"]]);
    coordinator.dispose();
    coordinator.retry();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const onError = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi.fn().mockRejectedValue(new Error("write failed")),
      onPendingChange,
      onConfirmed: vi.fn(),
      onError,
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("retries a failed write and confirms the retained draft", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(undefined);
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const onError = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
      onError,
    });

    coordinator.change("retained draft");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    coordinator.retry();
    await vi.advanceTimersByTimeAsync(0);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("retained draft");
    expect(onConfirmed).toHaveBeenCalledWith("retained draft");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
});
