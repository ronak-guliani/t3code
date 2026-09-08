import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  fetchEnvironmentShellSnapshot,
  ShellSnapshotLoader,
  shellSnapshotLoaderLayer,
} from "./shellSnapshotHttp.ts";
import {
  fetchEnvironmentThreadSnapshot,
  ThreadSnapshotLoader,
  threadSnapshotLoaderLayer,
} from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: `${TARGET.wsBaseUrl}/ws`,
  httpAuthorization: null,
  target: TARGET,
};
const THREAD_ID = ThreadId.make("thread/with space");
const LOADERS = Layer.merge(shellSnapshotLoaderLayer, threadSnapshotLoaderLayer);

describe("fork snapshot HTTP compatibility", () => {
  it.effect("retains cookie authentication for the existing shell endpoint", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const snapshot = {
        snapshotSequence: 7,
        projects: [],
        threads: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json(snapshot));
      }) satisfies typeof fetch;

      const result = yield* fetchEnvironmentShellSnapshot({
        prepared: PREPARED,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual(snapshot);
      expect(calls).toHaveLength(1);
      expect(String(calls[0]![0])).toBe(
        "https://environment.example.test/api/orchestration/shell-snapshot",
      );
      expect(calls[0]![1].credentials).toBe("include");
    }),
  );

  it.effect("uses fork snapshot paths and binds DPoP to the same encoded request path", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const proofUrls: string[] = [];
      const headers: Headers[] = [];
      const fetchFn = ((request, init) => {
        urls.push(String(request));
        headers.push(new Headers(init?.headers));
        return Promise.resolve(new Response(null, { status: 404 }));
      }) satisfies typeof fetch;
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofUrls.push(input.url);
            expect(input.method).toBe("GET");
            expect(input.accessToken).toBe("test-access-token");
            return "test-proof";
          }),
      });

      yield* fetchEnvironmentThreadSnapshot({
        prepared: {
          ...PREPARED,
          httpAuthorization: { _tag: "Dpop", accessToken: "test-access-token" },
        },
        threadId: THREAD_ID,
        signer: Option.some(signer),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.exit);
      yield* fetchEnvironmentShellSnapshot({
        prepared: {
          ...PREPARED,
          httpAuthorization: { _tag: "Dpop", accessToken: "test-access-token" },
        },
        signer: Option.some(signer),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.exit);

      expect(urls).toEqual([
        "https://environment.example.test/api/orchestration/threads/thread%2Fwith%20space/snapshot",
        "https://environment.example.test/api/orchestration/shell-snapshot",
      ]);
      expect(proofUrls).toEqual(urls);
      expect(headers[0]?.get("authorization")).toBe("DPoP test-access-token");
      expect(headers[0]?.get("dpop")).toBe("test-proof");
    }),
  );

  it.effect("falls back to socket snapshots when an older server lacks the HTTP endpoint", () =>
    Effect.gen(function* () {
      const shell = yield* ShellSnapshotLoader;
      const thread = yield* ThreadSnapshotLoader;
      expect(Option.isNone(yield* shell.load(PREPARED))).toBe(true);
      expect(Option.isNone(yield* thread.load(PREPARED, THREAD_ID))).toBe(true);
    }).pipe(
      Effect.provide(
        LOADERS.pipe(
          Layer.provide(
            remoteHttpClientLayer(() => Promise.resolve(new Response(null, { status: 404 }))),
          ),
        ),
      ),
    ),
  );

  it.effect("does not turn HTTP-client defects into successful empty snapshots", () =>
    Effect.gen(function* () {
      const shell = yield* ShellSnapshotLoader;
      const thread = yield* ThreadSnapshotLoader;
      const results = [
        yield* Effect.exit(shell.load(PREPARED).pipe(Effect.asVoid)),
        yield* Effect.exit(thread.load(PREPARED, THREAD_ID).pipe(Effect.asVoid)),
      ];
      for (const result of results) {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(true);
          expect(Cause.squash(result.cause)).toBe("snapshot-client-defect");
        }
      }
    }).pipe(
      Effect.provide(
        LOADERS.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("snapshot-client-defect")),
            ),
          ),
        ),
      ),
    ),
  );
});
