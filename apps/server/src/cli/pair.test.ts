import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../cli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  decideTailscaleMapping,
  DevServerNotProxiableError,
  resolveCandidatesForBaseDir,
  resolveDirectPairingBaseUrl,
  resolveTailscaleLocalTarget,
  ServePortOccupiedError,
  ServePortUnreachableError,
  ServesOtherEnvironmentError,
} from "./pair.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
    Layer.mergeAll(CliRuntimeLayer, TestConsole.layer),
  );

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              environmentId: "pair-test-environment",
              label: "Pair test",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        return Effect.die(new Error("Expected descriptor server TCP address."));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("pair target resolution", () => {
  it.effect("prefers service state before foreground state", () =>
    Effect.gen(function* () {
      const candidates = yield* resolveCandidatesForBaseDir("/tmp/t3-pair-base", "/service/state");
      expect(candidates.map(({ source, statePath }) => ({ source, statePath }))).toEqual([
        { source: "service", statePath: "/service/state" },
        {
          source: "foreground",
          statePath: "/tmp/t3-pair-base/userdata/server-runtime.json",
        },
        { source: "foreground", statePath: "/tmp/t3-pair-base/dev/server-runtime.json" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("selects canonical direct and Tailscale local targets", () => {
    const state = {
      version: 1,
      pid: process.pid,
      port: 3_773,
      origin: "http://127.0.0.1:3773",
      startedAt: "2026-08-01T00:00:00.000Z",
    } as const;
    expect(resolveDirectPairingBaseUrl({ ...state, host: "192.168.1.20" })).toBe(
      "http://192.168.1.20:3773",
    );
    expect(resolveTailscaleLocalTarget({ ...state, devUrl: "http://localhost:5733/" })).toEqual({
      localPort: 5_733,
    });
    expect(
      resolveTailscaleLocalTarget({ ...state, devUrl: "https://localhost:5733/" }),
    ).toBeInstanceOf(DevServerNotProxiableError);
  });

  it("refuses Tailscale collisions and only reuses the same environment", () => {
    const descriptor = {
      environmentId: EnvironmentId.make("environment-one"),
      label: "One",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: true },
    } as const;
    expect(
      decideTailscaleMapping({
        existing: { _tag: "descriptor", descriptor },
        environmentId: "environment-one",
        devServer: false,
        servePort: 443,
        servePortConfigured: true,
      }),
    ).toBe("reuse");
    expect(
      decideTailscaleMapping({
        existing: { _tag: "descriptor", descriptor },
        environmentId: "environment-two",
        devServer: false,
        servePort: 443,
        servePortConfigured: true,
      }),
    ).toBeInstanceOf(ServesOtherEnvironmentError);
    expect(
      decideTailscaleMapping({
        existing: { _tag: "not-a-t3-server" },
        environmentId: "environment-one",
        devServer: false,
        servePort: 8443,
        servePortConfigured: true,
      }),
    ).toBeInstanceOf(ServePortOccupiedError);
    expect(
      decideTailscaleMapping({
        existing: { _tag: "unreachable" },
        environmentId: "environment-one",
        devServer: false,
        servePort: 9443,
        servePortConfigured: true,
      }),
    ).toBeInstanceOf(ServePortUnreachableError);
    expect(
      decideTailscaleMapping({
        existing: { _tag: "unreachable" },
        environmentId: "environment-one",
        devServer: false,
        servePort: 9443,
        servePortConfigured: false,
      }),
    ).toBe("configure");
  });
});

describe("t3 pair", () => {
  it.effect("mints a standard client credential for the requested base directory", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "userdata", "environment-id"),
          "pair-test-environment\n",
        );
        yield* persistServerRuntimeState({
          path: statePath,
          state: makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--ttl", "1h", "--label", "Test phone"]),
        );
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.include(output, "Token:");
        assert.include(output, "Expires:");
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));

        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        const credentials = JSON.parse(listed) as ReadonlyArray<{ readonly label?: string }>;
        expect(credentials).toHaveLength(1);
        expect(credentials[0]?.label).toBe("Test phone");

        const secondBaseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-pair-second-base-"),
        );
        NodeFS.mkdirSync(NodePath.join(secondBaseDir, "userdata"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(secondBaseDir, "userdata", "environment-id"),
          "pair-test-environment\n",
        );
        yield* persistServerRuntimeState({
          path: NodePath.join(secondBaseDir, "userdata", "server-runtime.json"),
          state: makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });
        yield* captureStdout(
          runCli(["pair", "--base-dir", secondBaseDir, "--label", "Second base phone"]),
        );
        const secondListed = JSON.parse(
          yield* captureStdout(
            runCli(["auth", "pairing", "list", "--base-dir", secondBaseDir, "--json"]),
          ),
        ) as ReadonlyArray<{ readonly label?: string }>;
        expect(secondListed).toHaveLength(1);
        expect(secondListed[0]?.label).toBe("Second base phone");
        expect(credentials[0]?.label).toBe("Test phone");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects stale and unreachable runtime state without minting a credential", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stale-"));
      yield* persistServerRuntimeState({
        path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
        state: {
          ...makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: 1,
          }),
          pid: 4_194_305,
        },
      });

      const error = yield* runCli(["pair", "--base-dir", baseDir]).pipe(
        Effect.flip,
        Effect.provide(CliRuntimeLayer),
      );
      expect(String(error)).toContain("NoRunningServerError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
