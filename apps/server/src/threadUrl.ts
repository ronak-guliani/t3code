import type { ThreadId, ThreadUrl } from "@t3tools/contracts";
import { buildThreadUrl } from "@t3tools/shared/threadUrl";
import { Context, Effect, Layer } from "effect";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export function resolveActiveAppOrigin(
  config: Pick<ServerConfigShape, "devUrl" | "host" | "port">,
): string {
  if (config.devUrl) {
    return config.devUrl.origin;
  }
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "localhost";
  return `http://${hostname}:${config.port}`;
}

export interface ThreadUrlBuilderShape {
  readonly forThread: (threadId: ThreadId) => ThreadUrl;
}

export class ThreadUrlBuilder extends Context.Service<ThreadUrlBuilder, ThreadUrlBuilderShape>()(
  "t3/server/ThreadUrlBuilder",
) {}

const ThreadUrlBuilderFromEnvironment = Layer.effect(
  ThreadUrlBuilder,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const environment = yield* ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const appOrigin = resolveActiveAppOrigin(config);
    return {
      forThread: (threadId) => buildThreadUrl({ appOrigin, environmentId, threadId }),
    } satisfies ThreadUrlBuilderShape;
  }),
);

export const ThreadUrlBuilderLive = ThreadUrlBuilderFromEnvironment.pipe(
  Layer.provide(ServerEnvironmentLive),
);
