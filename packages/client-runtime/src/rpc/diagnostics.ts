import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface RpcDiagnostic {
  readonly phase: "started" | "succeeded" | "failed" | "interrupted";
  readonly environmentId: string;
  readonly generation: number;
  readonly method: string;
  readonly commandId?: string;
  readonly threadId?: string;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly sequence?: number;
}

export class EnvironmentRpcDiagnostics extends Context.Reference<{
  readonly record: (event: RpcDiagnostic) => Effect.Effect<void>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcDiagnostics", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export function rpcCommandIdentity(input: unknown): Pick<RpcDiagnostic, "commandId" | "threadId"> {
  if (typeof input !== "object" || input === null) return {};
  return {
    ...("commandId" in input && typeof input.commandId === "string"
      ? { commandId: input.commandId }
      : {}),
    ...("threadId" in input && typeof input.threadId === "string"
      ? { threadId: input.threadId }
      : {}),
  };
}
