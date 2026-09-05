import { ConnectionCompatibility, EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcDiagnostics } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { AppState, Platform } from "react-native";

import { uuidv4 } from "../lib/uuid";
import { MobileStorage } from "../persistence/mobile-storage";
import { OWNED_MOBILE_PROTOCOL_VERSION, validateMobileCompatibility } from "./compatibility";
import { mobileDiagnosticStore } from "./diagnostic-store";

const appSessionId = uuidv4();

export const mobileConnectionPolicyLayer = Layer.mergeAll(
  Layer.succeed(ConnectionCompatibility, { validate: validateMobileCompatibility }),
  Layer.succeed(EnvironmentRpcDiagnostics, {
    record: (event) => Effect.sync(() => mobileDiagnosticStore.record({ kind: "rpc", event })),
  }),
);

export const mobileConnectionDiagnosticsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const storage = yield* MobileStorage;
    yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.tap((id) => Effect.sync(() => mobileDiagnosticStore.setDeviceId(id))),
      Effect.catch(() =>
        Effect.sync(() => mobileDiagnosticStore.record({ kind: "device-identity-unavailable" })),
      ),
    );
    const recordAppState = (state: string) =>
      mobileDiagnosticStore.record({
        kind: "app-state",
        state:
          state === "active" || state === "inactive" || state === "background" ? state : "unknown",
      });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        recordAppState(AppState.currentState);
        return AppState.addEventListener("change", recordAppState);
      }),
      (subscription) => Effect.sync(() => subscription.remove()),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.switchMap((entries) =>
        Stream.fromIterable(entries.keys()).pipe(
          Stream.flatMap(
            (environmentId) =>
              registry.stateChanges(environmentId).pipe(
                Stream.map((state) => ({ environmentId, state })),
                Stream.catchTag("EnvironmentNotRegisteredError", () => Stream.empty),
              ),
            { concurrency: "unbounded" },
          ),
        ),
      ),
      Stream.runForEach(({ environmentId, state }) =>
        Effect.sync(() =>
          mobileDiagnosticStore.record({ kind: "connection", environmentId, state }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

export function mobileDiagnosticReport(): string {
  return JSON.stringify(
    {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      appSessionId,
      app: {
        version: Constants.expoConfig?.version ?? null,
        nativeBuild: Constants.nativeBuildVersion,
        variant: Constants.expoConfig?.extra?.appVariant ?? "production",
        platform: Platform.OS,
        osVersion: Device.osVersion,
        deviceModel: Device.modelName,
        ownedMobileProtocolVersion: OWNED_MOBILE_PROTOCOL_VERSION,
      },
      ...mobileDiagnosticStore.snapshot(),
    },
    null,
    2,
  );
}
