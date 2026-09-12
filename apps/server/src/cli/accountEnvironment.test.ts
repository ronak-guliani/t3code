import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, AuthStandardClientScopes } from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import { assert, it } from "@effect/vitest";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  SecretStorePersistError,
  SecretStoreReadError,
  type ServerSecretStoreShape,
} from "../auth/ServerSecretStore.ts";
import {
  decodeUsableEnvironmentTokenCache,
  findReusableEnvironmentToken,
  makeCliDpopSigner,
  makeEnvironmentTokenStore,
  makeRelayTokenStore,
  resolveCliEnvironmentCandidate,
} from "./accountEnvironment.ts";

const token = {
  clientId: RelayWebClientId,
  authorizationScope: [...AuthStandardClientScopes].sort().join(" "),
  accountId: "account-a",
  environmentId: EnvironmentId.make("environment-1"),
  relayUrl: "https://relay-a.example.test",
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
      relayUrl: "https://relay-a.example.test",
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
    })?.accessToken,
    "environment-token",
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-b",
      environmentId,
      relayUrl: "https://relay-a.example.test",
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
    }),
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      relayUrl: "https://relay-a.example.test",
      dpopThumbprint: "thumbprint-b",
      nowEpochMs: 1_000_000,
    }),
  );
});

it("does not reuse environment credentials issued through a different relay", () => {
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId: EnvironmentId.make("environment-1"),
      relayUrl: "https://relay-b.example.test",
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
    }),
  );
});

it.effect("invalidates legacy environment credentials without a relay binding", () =>
  Effect.gen(function* () {
    const { relayUrl: _, ...legacyToken } = token;
    assert.deepEqual(yield* decodeUsableEnvironmentTokenCache([legacyToken]), []);
  }),
);

it("does not reuse rejected or nearly expired environment credentials", () => {
  const environmentId = EnvironmentId.make("environment-1");
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      relayUrl: "https://relay-a.example.test",
      dpopThumbprint: "thumbprint-a",
      nowEpochMs: 1_000_000,
      rejectedAccessToken: "environment-token",
    }),
  );
  assert.isUndefined(
    findReusableEnvironmentToken([token], {
      accountId: "account-a",
      environmentId,
      relayUrl: "https://relay-a.example.test",
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

it.effect("treats relay token cache failures as best-effort", () =>
  Effect.gen(function* () {
    const secrets: ServerSecretStoreShape = {
      get: (name) => Effect.fail(new SecretStoreReadError({ resource: name })),
      set: (name) => Effect.fail(new SecretStorePersistError({ resource: name })),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.fail(new SecretStorePersistError({ resource: name })),
      list: () => Effect.die("unused"),
    };
    const store = makeRelayTokenStore(secrets);

    assert.deepEqual(yield* store.load, []);
    yield* store.save([]);
    yield* store.clear;
  }),
);

it.effect("treats environment token cache failures as best-effort", () =>
  Effect.gen(function* () {
    const secrets: ServerSecretStoreShape = {
      get: (name) => Effect.fail(new SecretStoreReadError({ resource: name })),
      set: (name) => Effect.fail(new SecretStorePersistError({ resource: name })),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    };
    const store = makeEnvironmentTokenStore(secrets);

    assert.deepEqual(yield* store.load, []);
    yield* store.save([token]);
  }),
);

it("requires source-qualified manual selectors when account discovery is unavailable", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-account-discovery-"));
  try {
    const registry = {
      version: 2 as const,
      environments: {
        desktop: {
          id: "desktop",
          label: "Desktop",
          url: "https://desktop.example.test",
        },
      },
    };

    const manual = await Effect.runPromise(
      resolveCliEnvironmentCandidate(baseDir, registry, "manual:desktop").pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.equal(manual.source, "manual");

    const error = await Effect.runPromise(
      resolveCliEnvironmentCandidate(baseDir, registry, "desktop").pipe(
        Effect.flip,
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.include(error.message, "not signed in");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
