import {
  createAtomCommandScheduler,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceListInput,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { getEnvironmentHttpBaseUrl, readEnvironmentConnection } from "~/environments/runtime";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

interface Target<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

function deviceClient(environmentId: EnvironmentId): WsRpcClient["device"] {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return connection.client.device;
}

function command<Input, A>(
  label: string,
  execute: (client: WsRpcClient["device"], input: Input) => Promise<A>,
): AtomCommand<Target<Input>, A, never> {
  const scheduler = createAtomCommandScheduler();
  return {
    label,
    run: (registry: AtomRegistry.AtomRegistry, target: Target<Input>) =>
      scheduler.schedule(
        registry,
        { mode: "serial", key: ({ environmentId }) => environmentId },
        target,
        async (): Promise<AtomCommandResult<A, never>> => {
          try {
            return AsyncResult.success<A, never>(
              await execute(deviceClient(target.environmentId), target.input),
            );
          } catch (cause) {
            return AsyncResult.failure<A, never>(Cause.die(cause));
          }
        },
      ),
  };
}

const stateFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<DeviceServiceState, never>>((get) => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = deviceClient(environmentId).onState((state) => {
        get.setSelf(AsyncResult.success<DeviceServiceState, never>(state));
      });
    } catch (cause) {
      return AsyncResult.failure<DeviceServiceState, never>(Cause.die(cause));
    }
    get.addFinalizer(() => unsubscribe?.());
    return AsyncResult.initial<DeviceServiceState, never>(true);
  }).pipe(Atom.withLabel(`environment-data:device:state:${environmentId}`)),
);

export const deviceEnvironment = {
  configure: command<DeviceConfigureInput, DeviceServiceState>(
    "environment-data:device:configure",
    (client, input) => client.configure(input),
  ),
  list: command<DeviceListInput, DeviceServiceState>(
    "environment-data:device:list",
    (client, input) => client.list(input),
  ),
  open: command<DeviceOpenInput, DeviceSession>("environment-data:device:open", (client, input) =>
    client.open(input),
  ),
  close: command<DeviceCloseInput, void>("environment-data:device:close", (client, input) =>
    client.close(input),
  ),
  shutdown: command<DeviceShutdownInput, void>(
    "environment-data:device:shutdown",
    (client, input) => client.shutdown(input),
  ),
  detail: command<DeviceDetailInput, DeviceDetail>(
    "environment-data:device:detail",
    (client, input) => client.detail(input),
  ),
  action: command<DeviceActionInput, DeviceDetail>(
    "environment-data:device:action",
    (client, input) => client.action(input),
  ),
};

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

const EMPTY_STATE_ATOM = Atom.make(AsyncResult.initial<DeviceServiceState, never>()).pipe(
  Atom.withLabel("environment-data:device:empty"),
);

export function useDeviceState(environmentId: EnvironmentId | null): {
  readonly state: DeviceServiceState;
  readonly loaded: boolean;
} {
  const result = useAtomValue(
    environmentId === null ? EMPTY_STATE_ATOM : stateFamily(environmentId),
  );
  return AsyncResult.isSuccess(result)
    ? { state: result.value, loaded: true }
    : { state: EMPTY_DEVICE_STATE, loaded: false };
}

export function useDeviceHubAccess(
  environmentId: EnvironmentId | null,
  hostId = "local",
): DeviceHubAccess | null {
  if (environmentId === null) return null;
  const origin = getEnvironmentHttpBaseUrl(environmentId);
  if (origin === null) return null;
  const httpBase = new URL(EMPTY_DEVICE_STATE.hubBasePath, origin).toString().replace(/\/$/, "");
  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    query: { hostId },
    credentials: true,
  };
}

export function refreshDeviceHubAccess(_environmentId: EnvironmentId): void {}
