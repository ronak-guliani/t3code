import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_DIAGNOSTIC_LOG_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_CORRELATED_LOG_SCAN_BYTES = 8 * 1024 * 1024;

export interface ProviderDiagnosticEvent {
  readonly stream: "native" | "canonical";
  readonly threadId: string;
  readonly event: unknown;
}

export interface ProviderEventEvidence {
  readonly available: boolean;
  readonly truncated: boolean;
  readonly files: ReadonlyArray<string>;
  readonly scannedBytes: number;
  readonly events: ReadonlyArray<{
    readonly stream: "native" | "canonical";
    readonly type: string | null;
    readonly eventId: string | null;
    readonly turnId: string;
    readonly createdAt: string | null;
    readonly state: string | null;
    readonly stopReason: string | null;
    readonly assistantTextObserved: boolean;
  }>;
}

export interface CorrelatedServerEvidence {
  readonly serverLogs: {
    readonly available: boolean;
    readonly truncated: boolean;
    readonly files: ReadonlyArray<string>;
    readonly scannedBytes: number;
    readonly records: ReadonlyArray<{
      readonly timestamp: string | null;
      readonly level: string | null;
      readonly spanNames: ReadonlyArray<string>;
    }>;
  };
  readonly traces: {
    readonly available: boolean;
    readonly truncated: boolean;
    readonly files: ReadonlyArray<string>;
    readonly scannedBytes: number;
    readonly spans: ReadonlyArray<{
      readonly name: string;
      readonly traceId: string | null;
      readonly startedAt: string | null;
      readonly durationMs: number | null;
      readonly outcome: string | null;
    }>;
  };
}

export interface ThreadDiagnosticInput {
  readonly threadId: string;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly turnId: string | null;
  }>;
  readonly messagesComplete: boolean;
  readonly providerEvents: ReadonlyArray<ProviderDiagnosticEvent>;
  readonly providerEvidence: Pick<
    ProviderEventEvidence,
    "available" | "truncated" | "files" | "scannedBytes"
  >;
}

export interface ThreadDiagnosticSummary {
  readonly threadId: string;
  readonly turn: { readonly id: string; readonly state: string } | null;
  readonly provider: {
    readonly completion: string | null;
    readonly assistantText: "observed" | "unknown";
    readonly evidenceAvailable: boolean;
  };
  readonly persistence: { readonly assistantMessage: "present" | "absent" | "unknown" };
  readonly response: "incomplete" | "persisted" | "not-indicated" | "unknown";
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const containsTextBlock = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsTextBlock);
  const current = record(value);
  if (!current) return false;
  if (current.type === "text" && stringValue(current.text)) return true;
  return Object.values(current).some(containsTextBlock);
};

const canonicalAssistantTextObserved = (value: unknown): boolean => {
  const current = record(value);
  if (!current) return false;
  if (current.type === "content.delta") {
    const payload = record(current.payload);
    if (payload?.streamKind === "assistant_text" && stringValue(payload.delta)) return true;
  }

  const itemType = current.type ?? current.kind ?? current.sessionUpdate;
  if (
    [
      "agent_message",
      "agentMessage",
      "assistant_message",
      "assistantMessage",
      "assistant_text",
    ].includes(String(itemType)) &&
    (stringValue(current.text) !== null ||
      stringValue(current.content) !== null ||
      containsTextBlock(current.content))
  ) {
    return true;
  }

  return Object.values(current).some((child) =>
    Array.isArray(child)
      ? child.some(canonicalAssistantTextObserved)
      : canonicalAssistantTextObserved(child),
  );
};

const summarizeProviderEvent = (
  input: ProviderDiagnosticEvent,
  turnId: string,
): ProviderEventEvidence["events"][number] | null => {
  const event = record(input.event);
  if (!event || input.threadId.length === 0 || stringValue(event.turnId) !== turnId) return null;
  const payload = record(event.payload);
  return {
    stream: input.stream,
    type: stringValue(event.type),
    eventId: stringValue(event.eventId),
    turnId,
    createdAt: stringValue(event.createdAt),
    state: stringValue(payload?.state),
    stopReason: stringValue(payload?.stopReason),
    assistantTextObserved:
      event.assistantTextObserved === true || canonicalAssistantTextObserved(event),
  };
};

const orderedRotations = (
  entries: ReadonlyArray<string>,
  baseName: string,
): ReadonlyArray<string> =>
  entries
    .filter((entry) => new RegExp(`^${baseName.replaceAll(".", "\\.")}(?:\\.\\d+)?$`).test(entry))
    .toSorted((left, right) => {
      if (left === baseName) return -1;
      if (right === baseName) return 1;
      return Number(left.slice(`${baseName}.`.length)) - Number(right.slice(`${baseName}.`.length));
    });

const readRotatedJsonLines = async (input: {
  readonly directory: string;
  readonly baseName: string;
  readonly maxBytes?: number;
}) => {
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(input.directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        available: false,
        truncated: false,
        files: [] as ReadonlyArray<string>,
        scannedBytes: 0,
        records: [] as ReadonlyArray<unknown>,
      };
    }
    throw error;
  }

  const files = orderedRotations(entries, input.baseName);
  const records: Array<unknown> = [];
  let scannedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  const maxBytes = input.maxBytes ?? MAX_DIAGNOSTIC_LOG_SCAN_BYTES;

  for (const name of files) {
    const path = join(input.directory, name);
    const fileStats = await stat(path);
    totalBytes += fileStats.size;
    if (scannedBytes + fileStats.size > maxBytes) {
      truncated = true;
      break;
    }
    const contents = await readFile(path, "utf8");
    scannedBytes += Buffer.byteLength(contents);
    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        truncated = true;
      }
    }
  }

  return {
    available: files.length > 0,
    truncated: truncated || scannedBytes < totalBytes,
    files,
    scannedBytes,
    records,
  };
};

export async function readProviderEventEvidence(input: {
  readonly providerLogsDir: string;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<ProviderEventEvidence> {
  const logs = await readRotatedJsonLines({
    directory: input.providerLogsDir,
    baseName: "provider-events.ndjson",
  });
  const summaries: Array<ProviderEventEvidence["events"][number]> = [];
  for (const parsed of logs.records) {
    const wrapper = record(parsed);
    if (
      wrapper?.threadId !== input.threadId ||
      (wrapper.stream !== "native" && wrapper.stream !== "canonical")
    ) {
      continue;
    }
    const summary = summarizeProviderEvent(
      { stream: wrapper.stream, threadId: input.threadId, event: wrapper.event },
      input.turnId,
    );
    if (summary) summaries.push(summary);
  }

  return {
    available: logs.available,
    truncated: logs.truncated,
    files: logs.files,
    scannedBytes: logs.scannedBytes,
    events: summaries,
  };
}

const traceMatches = (span: Record<string, unknown>, threadId: string, turnId: string): boolean => {
  const attributes = record(span.attributes);
  const matchesThread = attributes?.threadId === threadId || attributes?.["thread.id"] === threadId;
  if (!matchesThread) return false;
  const turn = stringValue(attributes?.turnId) ?? stringValue(attributes?.["turn.id"]);
  return turn === null || turn === turnId;
};

const serverLogMatches = (
  line: Record<string, unknown>,
  threadId: string,
  turnId: string,
): boolean => {
  const annotations = record(line.annotations);
  const attributes = record(line.attributes);
  const matchedThread =
    annotations?.threadId === threadId ||
    line.threadId === threadId ||
    attributes?.threadId === threadId;
  if (!matchedThread) return false;
  const turn =
    stringValue(annotations?.turnId) ?? stringValue(line.turnId) ?? stringValue(attributes?.turnId);
  return turn === null || turn === turnId;
};

const timestampFromUnixNanos = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  } catch {
    return null;
  }
};

export async function readLocalServerEvidence(input: {
  readonly logsDir: string;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<CorrelatedServerEvidence> {
  const [logs, traces] = await Promise.all([
    readRotatedJsonLines({
      directory: input.logsDir,
      baseName: "server.log",
      maxBytes: MAX_CORRELATED_LOG_SCAN_BYTES,
    }),
    readRotatedJsonLines({
      directory: input.logsDir,
      baseName: "server.trace.ndjson",
      maxBytes: MAX_CORRELATED_LOG_SCAN_BYTES,
    }),
  ]);
  const serverLogRecords = logs.records.flatMap((value) => {
    const line = record(value);
    if (!line || !serverLogMatches(line, input.threadId, input.turnId)) return [];
    const spans = Array.isArray(line.spans)
      ? line.spans.flatMap((span) => {
          const current = record(span);
          const name = stringValue(current?.name);
          return name === null ? [] : [name];
        })
      : [];
    return [
      {
        timestamp: stringValue(line.timestamp),
        level: stringValue(line.level),
        spanNames: spans,
      },
    ];
  });
  const traceSpans = traces.records.flatMap((value) => {
    const span = record(value);
    if (!span || !traceMatches(span, input.threadId, input.turnId)) return [];
    const exit = record(span.exit);
    const status = record(span.status);
    return [
      {
        name: stringValue(span.name) ?? "unknown",
        traceId: stringValue(span.traceId),
        startedAt: timestampFromUnixNanos(span.startTimeUnixNano),
        durationMs: typeof span.durationMs === "number" ? span.durationMs : null,
        outcome: stringValue(exit?._tag) ?? stringValue(status?.code),
      },
    ];
  });

  return {
    serverLogs: {
      available: logs.available,
      truncated: logs.truncated,
      files: logs.files,
      scannedBytes: logs.scannedBytes,
      records: serverLogRecords,
    },
    traces: {
      available: traces.available,
      truncated: traces.truncated,
      files: traces.files,
      scannedBytes: traces.scannedBytes,
      spans: traceSpans,
    },
  };
}

export function summarizeThreadDiagnostic(input: ThreadDiagnosticInput): ThreadDiagnosticSummary {
  const turn = input.latestTurn;
  const matchingEvents = turn
    ? input.providerEvents
        .filter((entry) => entry.threadId === input.threadId)
        .map((entry) => summarizeProviderEvent(entry, turn.turnId))
        .filter((entry): entry is ProviderEventEvidence["events"][number] => entry !== null)
    : [];
  const completion = matchingEvents.findLast((event) => event.type === "turn.completed");
  const assistantTextObserved = matchingEvents.some((event) => event.assistantTextObserved);
  const assistantMessage = !turn
    ? "unknown"
    : input.messages.some(
          (message) => message.role === "assistant" && message.turnId === turn.turnId,
        )
      ? "present"
      : input.messagesComplete
        ? "absent"
        : "unknown";
  const response = !turn
    ? "unknown"
    : assistantMessage === "present"
      ? "persisted"
      : assistantTextObserved && assistantMessage === "absent"
        ? "incomplete"
        : !input.providerEvidence.available || input.providerEvidence.truncated
          ? "unknown"
          : completion?.stopReason === "tool_use"
            ? "not-indicated"
            : "unknown";

  return {
    threadId: input.threadId,
    turn: turn ? { id: turn.turnId, state: turn.state } : null,
    provider: {
      completion: completion?.stopReason ?? null,
      assistantText: assistantTextObserved ? "observed" : "unknown",
      evidenceAvailable: input.providerEvidence.available,
    },
    persistence: { assistantMessage },
    response,
  };
}
