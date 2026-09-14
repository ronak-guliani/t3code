/**
 * Credentials for the Device panel's media requests.
 *
 * The panel reaches simulator streams through `/api/device-hub/*` on the
 * environment origin. `<img>`, `EventSource`, and `WebSocket` cannot set
 * bearer or DPoP headers, so bearer and DPoP connections mint a
 * short-lived WebSocket ticket and pass it as `wsTicket`, the same way the
 * app's own `/ws` upgrade authenticates. Cookie sessions send the cookie.
 *
 * A ticket lives five minutes server-side and is bound to the session, not
 * to one request, so one ticket covers everything a panel opens at once.
 * Callers fetch a fresh one each time they (re)connect a stream.
 */
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { requestEnvironmentRead } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;

export interface DeviceHubAccess {
  /** Absolute origin-relative base, e.g. `https://env.example/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Query parameters to append to every hub request; empty for cookie sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include cookies (same-origin session). */
  readonly credentials: boolean;
  /** Single-use tickets, one for each concurrently opened media channel. */
  readonly tickets?: {
    readonly video: string;
    readonly input: string;
    readonly prime: string;
    readonly mjpeg: string;
  };
}

export const resolveDeviceHubAccess = Effect.fn("clientRuntime.state.resolveDeviceHubAccess")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly hubBasePath: string;
  }): Effect.fn.Return<DeviceHubAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    const httpBase = environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath);
    const wsBase = httpBase.replace(/^http/, "ws");
    if (input.prepared.httpAuthorization === null) {
      return { httpBase, wsBase, query: {}, credentials: true };
    }
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const ticketUrl = environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      "/api/auth/websocket-ticket",
    );
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const ticket = yield* requestEnvironmentRead(
      input.prepared.httpAuthorization,
      ticketUrl,
      signer,
      (headers) =>
        executeEnvironmentHttpRequest(
          ticketUrl,
          TICKET_TIMEOUT_MS,
          client.auth.webSocketTicket({ headers }),
        ),
      "POST",
    );
    return {
      httpBase,
      wsBase,
      query: { wsTicket: ticket.ticket },
      credentials: false,
    };
  },
);

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
