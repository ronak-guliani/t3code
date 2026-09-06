import { EnvironmentId, type EnvironmentApi } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { getProjectFileSaveSession } from "./projectFileSaveSession";
import { resolveProjectFileQueryData } from "./projectFilesQueryState";

describe("project file save sessions", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retains a failed detached save and retries it after reopening without indexing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const environmentId = EnvironmentId.make("save-session-reopen");
    const writeFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValue(undefined);
    const listEntries = vi.fn();
    const readFile = vi.fn().mockResolvedValue({ relativePath: "file.ts", contents: "draft" });
    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: { writeFile, readFile, listEntries },
    } as unknown as EnvironmentApi);
    const session = getProjectFileSaveSession(environmentId, "/repo", "file.ts");
    const release = session.subscribe(vi.fn());
    session.change("draft");
    release();
    await vi.advanceTimersByTimeAsync(0);

    const reopened = getProjectFileSaveSession(environmentId, "/repo", "file.ts");
    expect(reopened).toBe(session);
    expect(reopened.getSnapshot()).toEqual({ pending: true, error: "permission denied" });
    expect(resolveProjectFileQueryData(environmentId, "/repo", "file.ts", null)?.contents).toBe(
      "draft",
    );
    const close = reopened.subscribe(vi.fn());
    reopened.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.getSnapshot()).toEqual({ pending: false, error: null });
    close();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(listEntries).not.toHaveBeenCalled();
    expect(getProjectFileSaveSession(environmentId, "/repo", "file.ts")).not.toBe(session);
  });

  it("serializes writes across detach and reattach while a save is in flight", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const environmentId = EnvironmentId.make("save-session-in-flight");
    let finish!: () => void;
    const writeFile = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: {
        writeFile,
        readFile: vi.fn().mockResolvedValue({ relativePath: "file.ts", contents: "second" }),
      },
    } as unknown as EnvironmentApi);
    const session = getProjectFileSaveSession(environmentId, "/repo", "file.ts");
    const release = session.subscribe(vi.fn());
    session.change("first");
    release();
    const reopened = getProjectFileSaveSession(environmentId, "/repo", "file.ts");
    const close = reopened.subscribe(vi.fn());
    reopened.change("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenLastCalledWith({
      cwd: "/repo",
      relativePath: "file.ts",
      contents: "second",
    });
    close();
  });
});
