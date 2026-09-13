import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Effect, PubSub, Stream } from "effect";

import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderDriverKind, ProviderAdapterShape<ProviderAdapterError>>
>;

export const makeProviderInstance = (input: {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly instanceId?: ProviderInstanceId;
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly enabled?: boolean;
}): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(input.adapter.provider);
  const instanceId = input.instanceId ?? defaultInstanceIdForDriver(driverKind);
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${driverKind}:instance:${instanceId}`,
    },
    displayName: input.displayName,
    ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
    enabled: input.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed({} as ServerProvider),
      refresh: Effect.succeed({} as ServerProvider),
      streamChanges: Stream.empty,
    },
    adapter: input.adapter,
    textGeneration: {} as TextGenerationShape,
  };
};

export const makeProviderInstanceRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => ({
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

export const makeInstanceRegistryMock = (adapters: KindAdapterMap): ProviderInstanceRegistryShape =>
  makeProviderInstanceRegistry(
    Object.values(adapters).flatMap((adapter) =>
      adapter === undefined ? [] : [makeProviderInstance({ adapter })],
    ),
  );
