import { RemoteAccessPairing, RemoteAccessSetup } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { RemoteAccess } from "./RemoteAccess.ts";

const responseHeaders = { "cache-control": "no-store", pragma: "no-cache" };
const encodePairing = Schema.encodeEffect(RemoteAccessPairing);

export const requireRemoteAccessOwner = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* ServerAuth;
  const session = yield* auth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only the host owner can manage Remote Access.",
      status: 403,
    });
  }
  if (request.method !== "GET") {
    const config = yield* ServerConfig;
    const origin = request.headers.origin;
    if (origin) {
      const matches = yield* Effect.try({
        try: () => {
          const url = new URL(origin);
          return (
            url.host === request.headers.host ||
            (config.devUrl !== undefined && url.origin === config.devUrl.origin)
          );
        },
        catch: () => new AuthError({ message: "Invalid request origin.", status: 403 }),
      });
      if (!matches)
        return yield* new AuthError({
          message: "Cross-origin Remote Access changes are not allowed.",
          status: 403,
        });
    }
  }
});

const respond = <A, R>(effect: Effect.Effect<A, AuthError, R>) =>
  Effect.gen(function* () {
    yield* requireRemoteAccessOwner;
    return yield* effect.pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: responseHeaders })),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError));

const status = HttpRouter.add(
  "GET",
  "/api/remote-access",
  respond(Effect.flatMap(RemoteAccess, (remote) => remote.getStatus)),
);

const update = HttpRouter.add(
  "POST",
  "/api/remote-access",
  respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return yield* new AuthError({ message: "Expected application/json.", status: 400 });
      }
      const input = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(32 * 1024)),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Union([
              Schema.Struct({ action: Schema.Literal("setup"), ...RemoteAccessSetup.fields }),
              Schema.Struct({ action: Schema.Literals(["enable", "disable"]) }),
            ]),
          ),
        ),
        Effect.mapError(
          () => new AuthError({ message: "Invalid Remote Access request.", status: 400 }),
        ),
      );
      const remote = yield* RemoteAccess;
      return yield* (
        input.action === "setup"
          ? remote.setup(input)
          : remote.setEnabled(input.action === "enable")
      ).pipe(Effect.mapError((error) => new AuthError({ message: error.message, status: 400 })));
    }),
  ),
);

const pairing = HttpRouter.add(
  "POST",
  "/api/remote-access/pair",
  respond(
    Effect.gen(function* () {
      const remote = yield* RemoteAccess;
      const publicUrl = yield* remote.verify.pipe(
        Effect.mapError((error) => new AuthError({ message: error.message, status: 400 })),
      );
      const auth = yield* ServerAuth;
      const credential = yield* auth.issuePairingCredential({
        label: "Remote device",
        role: "client",
      });
      return yield* encodePairing({ publicUrl, ...credential }).pipe(
        Effect.mapError(
          () => new AuthError({ message: "Could not encode pairing response.", status: 500 }),
        ),
      );
    }),
  ),
);

export const routes = Layer.mergeAll(status, update, pairing);
