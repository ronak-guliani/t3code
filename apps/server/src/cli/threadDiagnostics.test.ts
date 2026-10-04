import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readLocalServerEvidence,
  readProviderEventEvidence,
  summarizeThreadDiagnostic,
} from "./threadDiagnostics.ts";

const THREAD_ID = "thread-diagnostic";
const TURN_ID = "turn-diagnostic";

const baseInput = {
  threadId: THREAD_ID,
  latestTurn: {
    turnId: TURN_ID,
    state: "completed" as const,
    assistantMessageId: null,
  },
  messages: [],
  messagesComplete: true,
  providerEvents: [
    {
      stream: "canonical" as const,
      threadId: THREAD_ID,
      event: {
        type: "turn.completed",
        turnId: TURN_ID,
        payload: { state: "completed", stopReason: "end_turn" },
      },
    },
    {
      stream: "native" as const,
      threadId: THREAD_ID,
      event: {
        type: "item.completed",
        turnId: TURN_ID,
        item: { type: "agent_message", text: "private provider response" },
      },
    },
  ],
  providerEvidence: {
    available: true,
    truncated: false,
    files: ["provider-events.ndjson"],
    scannedBytes: 512,
  },
};

describe("thread diagnostics", () => {
  it("correlates provider text, end-turn completion, and a missing persisted assistant message", () => {
    const result = summarizeThreadDiagnostic(baseInput);

    expect(result).toMatchObject({
      threadId: THREAD_ID,
      turn: { id: TURN_ID, state: "completed" },
      provider: {
        completion: "end_turn",
        assistantText: "observed",
      },
      persistence: { assistantMessage: "absent" },
      response: "incomplete",
    });
    expect(JSON.stringify(result)).not.toContain("private provider response");
  });

  it("does not flag a tool-only completion as a missing assistant response", () => {
    const result = summarizeThreadDiagnostic({
      ...baseInput,
      providerEvents: [
        {
          stream: "canonical",
          threadId: THREAD_ID,
          event: {
            type: "turn.completed",
            turnId: TURN_ID,
            payload: { state: "completed", stopReason: "tool_use" },
          },
        },
      ],
    });

    expect(result.provider.assistantText).toBe("unknown");
    expect(result.response).toBe("not-indicated");
  });

  it("keeps response status unknown when provider logs or message history are incomplete", () => {
    const result = summarizeThreadDiagnostic({
      ...baseInput,
      messagesComplete: false,
      providerEvents: [],
      providerEvidence: {
        available: false,
        truncated: true,
        files: [],
        scannedBytes: 0,
      },
    });

    expect(result.provider.assistantText).toBe("unknown");
    expect(result.persistence.assistantMessage).toBe("unknown");
    expect(result.response).toBe("unknown");
  });

  it("requires matching thread and turn identifiers before attributing provider evidence", () => {
    const result = summarizeThreadDiagnostic({
      ...baseInput,
      providerEvents: baseInput.providerEvents.map((entry) => ({
        ...entry,
        threadId: "another-thread",
      })),
    });

    expect(result.provider.completion).toBeNull();
    expect(result.provider.assistantText).toBe("unknown");
    expect(result.response).toBe("unknown");
  });

  it("recognizes a completed ACP assistant message without exposing its content", () => {
    const result = summarizeThreadDiagnostic({
      ...baseInput,
      providerEvents: [
        {
          stream: "native",
          threadId: THREAD_ID,
          event: {
            type: "protocol",
            turnId: TURN_ID,
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message",
                  content: [{ type: "text", text: "private ACP response" }],
                },
              },
            },
          },
        },
      ],
    });

    expect(result.provider.assistantText).toBe("observed");
    expect(JSON.stringify(result)).not.toContain("private ACP response");
  });

  it("reads current and rotated provider logs, filtering by thread and turn without returning raw text", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "t3-thread-diagnostics-"));
    const logsDir = join(baseDir, "provider");
    await mkdir(logsDir, { recursive: true });
    const current = join(logsDir, "provider-events.ndjson");
    const rotated = `${current}.1`;
    await writeFile(
      current,
      `${JSON.stringify({
        observedAt: "2026-04-22T12:00:03.000Z",
        stream: "canonical",
        threadId: THREAD_ID,
        event: {
          type: "turn.completed",
          turnId: TURN_ID,
          payload: { state: "completed", stopReason: "end_turn" },
        },
      })}\n${JSON.stringify({
        observedAt: "2026-04-22T12:00:04.000Z",
        stream: "native",
        threadId: "other-thread",
        event: { type: "item.completed", item: { type: "agent_message", text: "wrong" } },
      })}\n`,
    );
    await writeFile(
      rotated,
      `${JSON.stringify({
        observedAt: "2026-04-22T12:00:02.000Z",
        stream: "native",
        threadId: THREAD_ID,
        event: {
          type: "item.completed",
          turnId: TURN_ID,
          item: { type: "agent_message", text: "do not return this" },
        },
      })}\n`,
    );

    try {
      const evidence = await readProviderEventEvidence({
        providerLogsDir: logsDir,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });

      expect(evidence.available).toBe(true);
      expect(evidence.files).toContain("provider-events.ndjson.1");
      expect(evidence.events).toHaveLength(2);
      expect(JSON.stringify(evidence)).not.toContain("do not return this");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("correlates rotated server logs and traces without returning private messages or attributes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "t3-server-evidence-"));
    const logsDir = join(baseDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "server.log.1"),
      `${JSON.stringify({
        timestamp: "2026-04-22T12:00:00.000Z",
        level: "Error",
        message: "private prompt text",
        annotations: { threadId: THREAD_ID, turnId: TURN_ID },
      })}\n`,
    );
    await writeFile(
      join(logsDir, "server.trace.ndjson"),
      `${JSON.stringify({
        name: "provider.sendTurn",
        traceId: "trace-1",
        startTimeUnixNano: String(Date.parse("2026-04-22T12:00:00.000Z") * 1_000_000),
        durationMs: 17,
        attributes: { threadId: THREAD_ID, turnId: TURN_ID, prompt: "private prompt text" },
        exit: { _tag: "Success" },
      })}\n`,
    );

    try {
      const evidence = await readLocalServerEvidence({
        logsDir,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });

      expect(evidence.serverLogs.records).toEqual([
        {
          timestamp: "2026-04-22T12:00:00.000Z",
          level: "Error",
          spanNames: [],
        },
      ]);
      expect(evidence.traces.spans).toEqual([
        {
          name: "provider.sendTurn",
          traceId: "trace-1",
          startedAt: "2026-04-22T12:00:00.000Z",
          durationMs: 17,
          outcome: "Success",
        },
      ]);
      expect(evidence.serverLogs.files).toContain("server.log.1");
      expect(JSON.stringify(evidence)).not.toContain("private prompt text");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
