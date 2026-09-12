import { EnvironmentId } from "@t3tools/contracts";
import { CloudSession, type CloudSessionIdentity } from "@t3tools/client-runtime/platform";
import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../../connection/runtime";

interface DeregisterInput {
  readonly environmentId: EnvironmentId;
  readonly identity: CloudSessionIdentity;
}

export const deregisterEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:deregister-environment",
  concurrency: {
    mode: "singleFlight",
    key: (input: DeregisterInput) => `${input.identity.accountId}:${input.environmentId}`,
  },
  execute: Effect.fn("cloud.deregisterEnvironment")(function* (input: DeregisterInput) {
    const session = yield* CloudSession;
    const relay = yield* ManagedRelay.ManagedRelayClient;
    const tokens = yield* TokenStore.RemoteDpopAccessTokenStore;
    const assertAccount = Effect.gen(function* () {
      const current = yield* session.identity;
      if (Option.isNone(current) || current.value !== input.identity) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "The T3 Connect account changed. Confirm deregistration again.",
        });
      }
    });
    yield* assertAccount;
    const clerkToken = yield* session.clerkToken;
    yield* assertAccount;
    yield* relay.unlinkEnvironment({ clerkToken, environmentId: input.environmentId });
    yield* assertAccount;
    yield* tokens.remove(input.environmentId);
  }),
});
