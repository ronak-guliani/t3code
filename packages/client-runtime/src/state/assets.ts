import {
  type AssetCreateUrlResult,
  type AssetCreateUrlInput,
  type ExecutionEnvironmentCapabilities,
  AssetResource,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";

export function compatibleAssetResource(
  resource: AssetResource,
  capabilities: ExecutionEnvironmentCapabilities,
): AssetResource {
  if (resource._tag === "media-file" && capabilities.mediaFiles !== true) {
    return { _tag: "workspace-file", threadId: resource.threadId, path: resource.path };
  }
  return resource;
}

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedErrorClass<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

export const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("asset-url:empty"),
);

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | {
      readonly _tag: "Success";
      readonly url: string;
      /** The host path the server chose to serve, when it differs from what was asked for. */
      readonly sourcePath?: string;
    };

export function assetUrlStateFromResult(
  result: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
  httpBaseUrl: string | null,
): AssetUrlState {
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (httpBaseUrl === null || result._tag !== "Success") return { _tag: "Loading" };
  const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
  };
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const createUrl = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    execute: (input: AssetCreateUrlInput) =>
      Effect.gen(function* () {
        let resource = input.resource;
        if (resource._tag === "media-file") {
          const supervisor = yield* EnvironmentSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session);
          if (Option.isSome(session)) {
            const config = yield* session.value.initialConfig;
            resource = compatibleAssetResource(resource, config.environment.capabilities);
          }
        }
        return yield* request(WS_METHODS.assetsCreateUrl, { ...input, resource });
      }),
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
