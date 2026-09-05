import { describe, expect, it, vi } from "vite-plus/test";

import {
  reportClientError,
  reportClientWarning,
  setClientLogHandler,
  type ClientLogEvent,
} from "./clientLogger";

describe("clientLogger", () => {
  it("forwards errors to the console and the installed handler", () => {
    const events: Array<ClientLogEvent> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setClientLogHandler((event) => {
        events.push(event);
      });
      reportClientError("boom", { code: 1 });
      expect(errorSpy).toHaveBeenCalledWith("boom", { code: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.level).toBe("error");
    } finally {
      setClientLogHandler(null);
      errorSpy.mockRestore();
    }
  });

  it("forwards warnings to the console and the installed handler", () => {
    const events: Array<ClientLogEvent> = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setClientLogHandler((event) => {
        events.push(event);
      });
      reportClientWarning("slow", 42);
      expect(warnSpy).toHaveBeenCalledWith("slow", 42);
      expect(events).toHaveLength(1);
      expect(events[0]?.level).toBe("warning");
    } finally {
      setClientLogHandler(null);
      warnSpy.mockRestore();
    }
  });
});
