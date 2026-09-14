import { describe, expect, it, vi } from "vite-plus/test";

const appStateMocks = vi.hoisted(() => {
  const handlers = new Set<(state: string) => void>();
  return {
    handlers,
    addEventListener: vi.fn((event: string, handler: (state: string) => void) => {
      expect(event).toBe("change");
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    }),
    emit: (state: string) => {
      handlers.forEach((handler) => {
        handler(state);
      });
    },
    reset: () => {
      handlers.clear();
      appStateMocks.addEventListener.mockClear();
    },
  };
});

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: appStateMocks.addEventListener,
  },
}));

import { subscribeToAppStateChange } from "./appForeground";

describe("appForeground", () => {
  it("shares one native listener across subscribers and fans events out", () => {
    appStateMocks.reset();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToAppStateChange(first);
    const unsubscribeSecond = subscribeToAppStateChange(second);

    expect(appStateMocks.addEventListener).toHaveBeenCalledTimes(1);

    appStateMocks.emit("active");
    expect(first).toHaveBeenCalledWith("active");
    expect(second).toHaveBeenCalledWith("active");

    unsubscribeFirst();
    appStateMocks.emit("background");
    expect(first).not.toHaveBeenCalledWith("background");
    expect(second).toHaveBeenCalledWith("background");

    unsubscribeSecond();
    expect(appStateMocks.handlers.size).toBe(0);
  });

  it("reinstalls the native listener after the last subscriber leaves", () => {
    appStateMocks.reset();
    const listener = vi.fn();
    const unsubscribe = subscribeToAppStateChange(listener);
    expect(appStateMocks.addEventListener).toHaveBeenCalledTimes(1);
    unsubscribe();

    const late = vi.fn();
    const unsubscribeLate = subscribeToAppStateChange(late);
    expect(appStateMocks.addEventListener).toHaveBeenCalledTimes(2);
    appStateMocks.emit("active");
    expect(late).toHaveBeenCalledWith("active");
    unsubscribeLate();
  });
});
