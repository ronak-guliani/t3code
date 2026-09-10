import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ServerSecretStoreShape } from "../auth/ServerSecretStore.ts";
import { findReusableEnvironmentToken, makeCliDpopSigner } from "./accountEnvironment.ts";

const token = {
  accountId: "account-a",
  environmentId: EnvironmentId.make("environment-1"),
  label: "Desktop",
  endpoint: {
    httpBaseUrl: "https://desktop.example.test",
    wsBaseUrl: "wss://desktop.example.test/ws",
    providerKind: "cloudflare_tunnel" as const,
  },
  accessToken: "environment-token",
  expiresAtEpochMs: 2_000_000,
  dpopThumbprint: "thumbprint-a",
};

it("reuses environment credentials only for the same account and DPoP key", () => {
  const environmentId = EnvironmentId.make("environment-1");
  assert.equal(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
    })?.accessToken,
    "environment-token",
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-b",
      environmentId,
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
    }),
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      dpopThumbprint: "thumbprint-b",
      nowEpochMs: 1_000_000,
    }),
  );
});

it("does not reuse rejected or nearly expired environment credentials", () => {
  const environmentId = EnvironmentId.make("environment-1");
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
      rejectedAccessToken: "environment-token",
    }),
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: token.expiresAtEpochMs - 30_000,
    }),
  );
});

it.effect("persists a DPoP key and creates bound proofs", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>();
    const secrets: ServerSecretStoreShape = {
      get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([...values.keys()]),
    };
    const first = yield* makeCliDpopSigner(secrets);
    const second = yield* makeCliDpopSigner(secrets);
    assert.equal(second.thumbprint, first.thumbprint);

    const proof = yield* second.createProof({
      method: "POST",
      url: "https://desktop.example.test/api/auth/websocket-ticket?ignored=true",
      accessToken: "access-token",
    });
    const verified = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://desktop.example.test/api/auth/websocket-ticket",
      expectedThumbprint: first.thumbprint,
      expectedAccessToken: "access-token",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
    });
    assert.isTrue(verified.ok);
  }),
);
