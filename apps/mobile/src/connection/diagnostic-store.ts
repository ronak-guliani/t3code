import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { RpcDiagnostic } from "@t3tools/client-runtime/rpc";

const EVENT_LIMIT = 200;
const identifier = (value: string) =>
  /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : "[redacted]";

type DiagnosticEvent =
  | { readonly kind: "rpc"; readonly event: RpcDiagnostic }
  | {
      readonly kind: "connection";
      readonly environmentId: string;
      readonly state: SupervisorConnectionState;
    }
  | { readonly kind: "app-state"; readonly state: "active" | "inactive" | "background" | "unknown" }
  | {
      readonly kind: "outbox";
      readonly commandId: string;
      readonly threadId: string;
      readonly phase: "queued" | "dispatching" | "acknowledged" | "retry" | "cancelled";
    }
  | { readonly kind: "device-identity-unavailable" };

export function createMobileDiagnosticStore() {
  const events: Readonly<Record<string, string | number>>[] = [];
  let deviceId: string | null = null;
  return {
    setDeviceId(value: string) {
      deviceId = identifier(value);
    },
    record(input: DiagnosticEvent) {
      const at = Date.now();
      let event: Readonly<Record<string, string | number>>;
      switch (input.kind) {
        case "rpc": {
          const request = input.event;
          event = {
            at,
            kind: input.kind,
            phase: request.phase,
            environmentId: identifier(request.environmentId),
            generation: request.generation,
            method: identifier(request.method),
            startedAt: request.startedAt,
            ...(request.commandId === undefined
              ? {}
              : { commandId: identifier(request.commandId) }),
            ...(request.threadId === undefined ? {} : { threadId: identifier(request.threadId) }),
            ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
            ...(request.sequence === undefined ? {} : { sequence: request.sequence }),
          };
          break;
        }
        case "connection":
          event = {
            at,
            kind: input.kind,
            environmentId: identifier(input.environmentId),
            generation: input.state.generation,
            phase: input.state.phase,
            network: input.state.network,
            attempt: input.state.attempt,
            ...(input.state.lastFailure === null ? {} : { reason: input.state.lastFailure.reason }),
          };
          break;
        case "outbox":
          event = {
            at,
            kind: input.kind,
            commandId: identifier(input.commandId),
            threadId: identifier(input.threadId),
            phase: input.phase,
          };
          break;
        case "app-state":
          event = { at, kind: input.kind, state: input.state };
          break;
        case "device-identity-unavailable":
          event = { at, kind: input.kind };
      }
      events.push(event);
      if (events.length > EVENT_LIMIT) events.shift();
    },
    snapshot() {
      return { deviceId, events: events.map((event) => ({ ...event })) };
    },
    clear() {
      events.length = 0;
    },
  };
}

export const mobileDiagnosticStore = createMobileDiagnosticStore();

export function recordOutboxDiagnostic(
  message: { readonly commandId: string; readonly threadId: string },
  phase: Extract<DiagnosticEvent, { kind: "outbox" }>["phase"],
) {
  mobileDiagnosticStore.record({
    kind: "outbox",
    commandId: message.commandId,
    threadId: message.threadId,
    phase,
  });
}
