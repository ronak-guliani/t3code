import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchDeviceAxTree, subscribeDeviceForeground } from "./deviceHubApi";

describe("foreground app events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears the last app when it exits and ignores malformed events", async () => {
    let source: FakeEventSource;
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      addEventListener(type: string, listener: (event: { data: string }) => void) {
        if (type === "message") this.onmessage = listener;
      }
      close = vi.fn();
      constructor() {
        source = this;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(
      {
        platform: "ios",
        deviceId: "test",
        access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
      },
      onChange,
    );
    await vi.waitFor(() => expect(source!.onmessage).not.toBeNull());
    const emit = (data: unknown) => source.onmessage?.({ data: JSON.stringify(data) });
    emit({ bundleId: "com.example.app", pid: 123 });
    emit({ bundleId: null });
    emit({ bundleId: "com.example.other" });
    emit({ bundleId: "" });
    emit({ other: "not app state" });
    expect(onChange.mock.calls.map(([app]) => app)).toEqual([
      { id: "com.example.app", pid: 123 },
      null,
      { id: "com.example.other" },
      null,
    ]);
    stop();
    expect(source!.close).toHaveBeenCalledOnce();
  });

  it("mints a fresh ticket for each bearer-authenticated read", async () => {
    const issueTicket = vi.fn().mockResolvedValueOnce("ticket-1").mockResolvedValueOnce("ticket-2");
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [] } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);
    const target = {
      platform: "ios" as const,
      deviceId: "test",
      access: {
        httpBase: "http://test",
        wsBase: "ws://test",
        query: { hostId: "local" },
        credentials: false,
        issueTicket,
      },
    };
    await fetchDeviceAxTree(target);
    await fetchDeviceAxTree(target);
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://test/vendor/serve-sim/helper/test/ax?hostId=local&wsTicket=ticket-1",
      "http://test/vendor/serve-sim/helper/test/ax?hostId=local&wsTicket=ticket-2",
    ]);
  });
});
