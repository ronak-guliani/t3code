import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vitest";
import { createMobileDiagnosticStore } from "./diagnostic-store";

describe("mobile diagnostic reports", () => {
  it("retains a bounded copy of recent events and clears without changing identity", () => {
    const store = createMobileDiagnosticStore();
    store.setDeviceId("device-id");
    for (let generation = 0; generation < 205; generation++) {
      store.record({
        kind: "connection",
        environmentId: "env",
        state: { ...AVAILABLE_CONNECTION_STATE, generation },
      });
    }
    const snapshot = store.snapshot();
    expect(snapshot.events).toHaveLength(200);
    expect(snapshot.events[0]?.generation).toBe(5);
    snapshot.events.length = 0;
    expect(store.snapshot().events).toHaveLength(200);
    store.clear();
    expect(store.snapshot()).toEqual({ deviceId: "device-id", events: [] });
  });

  it("exports only allowlisted fields, never URLs, request contents or error details", () => {
    const store = createMobileDiagnosticStore();
    const sensitiveEvent = {
      phase: "failed" as const,
      environmentId: "env",
      generation: 2,
      method: "orchestration.dispatchCommand",
      commandId: "command-1",
      threadId: "https://secret.example/pair#token=credential",
      startedAt: 10,
      durationMs: 4,
      text: "private prompt",
      attachments: ["private bytes"],
      authorization: "Bearer secret",
    };
    store.record({ kind: "rpc", event: sensitiveEvent });
    store.record({
      kind: "connection",
      environmentId: "env",
      state: {
        ...AVAILABLE_CONNECTION_STATE,
        lastFailure: new ConnectionBlockedError({
          reason: "authentication",
          detail: "secret error body",
        }),
      },
    });
    const report = JSON.stringify(store.snapshot());
    for (const secret of [
      "secret",
      "credential",
      "private",
      "authorization",
      "attachments",
      "https://",
    ]) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain("command-1");
    expect(report).toContain("[redacted]");
    expect(report).toContain("authentication");
  });
});
