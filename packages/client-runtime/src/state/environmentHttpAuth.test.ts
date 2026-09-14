import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EnvironmentAuthInvalidError, EnvironmentScopeRequiredError } from "@t3tools/contracts";
import { requestEnvironmentRead } from "./environmentHttpAuth.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";

const signer = Option.some(
  ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("key"),
    createProof: (input) => Effect.succeed(`${input.method}:${input.accessToken}`),
  }),
);

describe("environment HTTP renewal", () => {
  it.effect("does not retry permission failures or refresh rejected authorization scopes", () =>
    Effect.gen(function* () {
      const renewals: (string | undefined)[] = [];
      let requests = 0;
      const error = new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId: "test",
      });
      const failure = yield* requestEnvironmentRead(
        {
          _tag: "Dpop",
          accessToken: "current",
          renewAccessToken: (rejected) =>
            Effect.sync(() => {
              renewals.push(rejected);
              return "current";
            }),
        },
        "https://host.test/snapshot",
        signer,
        () =>
          Effect.suspend(() => {
            requests++;
            return Effect.fail(error);
          }),
      ).pipe(Effect.flip);
      expect(failure).toBe(error);
      expect(requests).toBe(1);
      expect(renewals).toEqual([undefined]);
    }),
  );
  it.effect("retries one rejected read with a fresh token and proof without reconnecting", () =>
    Effect.gen(function* () {
      const renewals: (string | undefined)[] = [];
      const headers: unknown[] = [];
      const result = yield* requestEnvironmentRead(
        {
          _tag: "Dpop",
          accessToken: "expired",
          renewAccessToken: (rejected) =>
            Effect.sync(() => {
              renewals.push(rejected);
              return rejected ? "replacement" : "current";
            }),
        },
        "https://host.test/snapshot",
        signer,
        (requestHeaders) =>
          Effect.suspend(() => {
            headers.push(requestHeaders);
            return headers.length === 1
              ? Effect.fail(
                  new EnvironmentAuthInvalidError({
                    code: "auth_invalid",
                    reason: "invalid_credential",
                    traceId: "test",
                  }),
                )
              : Effect.succeed("snapshot");
          }),
      );
      expect(result).toBe("snapshot");
      expect(renewals).toEqual([undefined, "current"]);
      expect(headers).toEqual([
        { authorization: "DPoP current", dpop: "GET:current" },
        { authorization: "DPoP replacement", dpop: "GET:replacement" },
      ]);
    }),
  );

  it.effect("does not loop when the renewed credential is also rejected", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failure = yield* requestEnvironmentRead(
        {
          _tag: "Dpop",
          accessToken: "old",
          renewAccessToken: () => Effect.succeed("new"),
        },
        "https://host.test/snapshot",
        signer,
        () =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "test",
              }),
            );
          }),
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("EnvironmentAuthInvalidError");
      expect(calls).toBe(2);
    }),
  );
});
