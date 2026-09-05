import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  clientSettings,
  events,
  getDisplayMedia,
  registrySet,
  requestDisplayMediaCapture,
  save,
  startScreencast,
  stopScreencast,
} = vi.hoisted(() => {
  const events: string[] = [];
  return {
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getDisplayMedia: vi.fn(),
    requestDisplayMediaCapture: vi.fn((_tabId: string) => undefined),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).sort().join(",")}`,
      );
    }),
    save: vi.fn(async (tabId: string) => ({
      id: "recording-test",
      tabId,
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn(async (_tabId: string) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: {
      onFrame: vi.fn(),
      save,
      startScreencast: async (tabId: string) => {
        await startScreencast(tabId);
        requestDisplayMediaCapture(tabId);
      },
      stopScreencast,
    },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => clientSettings,
}));

import {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingCaptureTimeoutError,
  BrowserRecordingConflictError,
  BrowserRecordingFormatUnavailableError,
  BrowserRecordingStartCancelledError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["video/webm;codecs=vp9"]);
  static outputMimeType: string | undefined;

  static isTypeSupported(type: string): boolean {
    return this.supportedTypes.has(type);
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;
  readonly stream: MediaStream;
  readonly options: MediaRecorderOptions | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType =
      FakeMediaRecorder.outputMimeType ?? options?.mimeType ?? "video/browser-default";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  let animationFrameCount = 0;

  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.supportedTypes = new Set(["video/webm;codecs=vp9"]);
    FakeMediaRecorder.outputMimeType = undefined;
    clientSettings.browserRecordingFrameRate = 30;
    animationFrameCount = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCount += 1;
      callback(animationFrameCount);
      return animationFrameCount;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    getDisplayMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    });
    requestDisplayMediaCapture.mockImplementation((tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function" || trigger(tabId) !== true) {
        throw new Error(`No pending display-media capture for ${tabId}.`);
      }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  afterEach(async () => {
    await Promise.all(
      Array.from(readActiveBrowserRecordingTabIds(), (tabId) =>
        stopBrowserRecording(tabId).catch(() => null),
      ),
    );
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records the native tab stream through the desktop capture trigger", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    getDisplayMedia.mockResolvedValueOnce(stream);

    await startBrowserRecording("recording-tab");

    expect(requestDisplayMediaCapture).toHaveBeenCalledWith("recording-tab");
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { max: 30 } },
    });
    expect(FakeMediaRecorder.instances[0]?.stream).toBe(stream);
    expect(useBrowserSurfaceStore.getState().activityByTabId["recording-tab"]).toBe(1);

    await stopBrowserRecording("recording-tab");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(useBrowserSurfaceStore.getState().activityByTabId["recording-tab"]).toBeUndefined();
  });

  it("uses the configured frame rate and best supported encoder", async () => {
    clientSettings.browserRecordingFrameRate = 60;
    FakeMediaRecorder.supportedTypes = new Set([
      "video/mp4;codecs=avc1.42e01e",
      "video/webm;codecs=vp9",
      "video/webm;codecs=av1",
    ]);
    FakeMediaRecorder.outputMimeType = "video/webm;codecs=av01";

    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { max: 60 } },
    });
    expect(FakeMediaRecorder.instances[0]?.options).toEqual({
      mimeType: "video/webm;codecs=av1",
    });
    expect(save).toHaveBeenCalledWith(
      "recording-tab",
      "video/webm;codecs=av01",
      expect.any(Uint8Array),
    );
  });

  it("reports a missing MediaRecorder output format", async () => {
    FakeMediaRecorder.supportedTypes = new Set();
    FakeMediaRecorder.outputMimeType = "";

    await startBrowserRecording("recording-tab");

    await expect(stopBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingFormatUnavailableError,
    );
    expect(save).not.toHaveBeenCalled();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("serializes display-media grants while allowing concurrent recordings", async () => {
    let finishFirstCapture!: (stream: MediaStream) => void;
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    getDisplayMedia
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            finishFirstCapture = resolve;
          }),
      )
      .mockResolvedValueOnce(stream);

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
    const secondStart = startBrowserRecording("recording-tab-2");
    await vi.waitFor(() => expect(readActiveBrowserRecordingTabIds().size).toBe(2));

    expect(startScreencast).toHaveBeenCalledTimes(1);
    finishFirstCapture(stream);
    await Promise.all([firstStart, secondStart]);

    expect(startScreencast.mock.calls).toEqual([["recording-tab"], ["recording-tab-2"]]);
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued start before it receives the native grant", async () => {
    let finishFirstCapture!: (stream: MediaStream) => void;
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishFirstCapture = resolve;
        }),
    );

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
    const secondStart = startBrowserRecording("recording-tab-2");
    await vi.waitFor(() => expect(readActiveBrowserRecordingTabIds().size).toBe(2));

    const secondStop = stopBrowserRecording("recording-tab-2");
    await expect(secondStart).rejects.toBeInstanceOf(BrowserRecordingStartCancelledError);
    await expect(secondStop).resolves.toBeNull();
    expect(startScreencast).toHaveBeenCalledTimes(1);

    finishFirstCapture(stream);
    await firstStart;
  });

  it("stops a late stream after bounded capture acquisition times out", async () => {
    vi.useFakeTimers();
    let finishCapture!: (stream: MediaStream) => void;
    const stopTrack = vi.fn();
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishCapture = resolve;
        }),
    );

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
    const rejection = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingCaptureTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());

    finishCapture({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("shares one stop operation and blocks a same-tab restart while stopping", async () => {
    let finishStop!: () => void;
    stopScreencast.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishStop = () => resolve(undefined);
        }),
    );
    await startBrowserRecording("recording-tab");

    const firstStop = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    const duplicateStop = stopBrowserRecording("recording-tab");
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStop();
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);
    expect(duplicateArtifact).toEqual(firstArtifact);
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps recordings addressable by runtime id across server epochs", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-scoped"),
    };
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-a", "tab_1");
    await startBrowserRecording(runtimeTabId, threadRef, "tab_1");

    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: "tab_1" },
    ]);
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, "tab_1")).toBe(runtimeTabId);

    const replacementRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-b", "tab_1");
    await expect(
      startBrowserRecording(replacementRuntimeTabId, threadRef, "tab_1"),
    ).rejects.toBeInstanceOf(BrowserRecordingConflictError);
  });
});
