import type { ServerConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ConnectionBlockedError } from "./model.ts";

export class ConnectionCompatibility extends Context.Reference<{
  readonly validate: (config: ServerConfig) => Effect.Effect<void, ConnectionBlockedError>;
}>("@t3tools/client-runtime/connection/ConnectionCompatibility", {
  defaultValue: () => ({ validate: () => Effect.void }),
}) {}
