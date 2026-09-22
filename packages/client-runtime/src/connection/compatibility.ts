import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

export class ConnectionCompatibility extends Context.Reference<{
  readonly validate: (config: ServerConfig) => Effect.Effect<void, ConnectionBlockedError>;
}>("@t3tools/client-runtime/connection/ConnectionCompatibility", {
  defaultValue: () => ({ validate: () => Effect.void }),
}) {}

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return new ConnectionBlockedError({
    reason: "unsupported",
    detail:
      serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
        ? `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`
        : `This client requires a newer server. Update T3 Code on ${descriptor.label} to connect.`,
  });
}

export function validateOrchestrationProtocol(
  descriptor: ExecutionEnvironmentDescriptor,
): Effect.Effect<void, ConnectionAttemptError> {
  const error = orchestrationProtocolCompatibilityError(descriptor);
  return error === null ? Effect.void : Effect.fail(error);
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}
