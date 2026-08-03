import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import { disableTailscaleServe } from "@t3tools/tailscale";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient } from "effect/unstable/http";

import { cli } from "../cli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  confirmNewTailscaleMapping,
  decideTailscaleMapping,
  DevServerNotProxiableError,
  discoverPairTargetFromCandidates,
  PairingCleanupFailedError,
  PairingCredentialCleanupFailedError,
  PairingEndpointUnavailableError,
  resolveCandidatesForBaseDir,
  resolveDirectPairingBaseUrl,
  resolveDirectPairingBaseUrlCandidates,
  resolveVerifiedDirectPairingBase,
  resolveTailscaleLocalTarget,
  ServePortOccupiedError,
  ServePortUnreachableError,
  ServesOtherEnvironmentError,
  TailscaleEndpointVerificationError,
  useResolvedPairingBase,
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

const withDescriptorServer = <A, E, R>(
  run: (origin: string) => Effect.Effect<A, E, R>,
  environmentId = "pair-test-environment",
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              environmentId,
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

const writeRuntimeState = (input: {
  readonly baseDir: string;
  readonly origin: string;
  readonly host?: string;
  readonly devUrl?: string;
  readonly pid?: number;
  readonly statePath?: string;
}) =>
  Effect.gen(function* () {
    const statePath =
      input.statePath ?? NodePath.join(input.baseDir, "userdata", "server-runtime.json");
    NodeFS.mkdirSync(NodePath.join(input.baseDir, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(input.baseDir, "userdata", "environment-id"),
      "pair-test-environment\n",
    );
    yield* persistServerRuntimeState({
      path: statePath,
      state: {
        ...makePersistedServerRuntimeState({
          config: {
            host: input.host ?? "127.0.0.1",
            devUrl: input.devUrl === undefined ? undefined : new URL(input.devUrl),
          },
          port: Number(new URL(input.origin).port),
        }),
        origin: input.origin,
        ...(input.pid === undefined ? {} : { pid: input.pid }),
      },
    });
    return statePath;
  });

const encoder = new TextEncoder();
const makeProcessSpawnerLayer = (
  handler: (args: ReadonlyArray<string>) => {
    readonly code?: number;
    readonly stderr?: string;
  },
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as { readonly args: ReadonlyArray<string> };
      const result = handler(child.args);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(encoder.encode(result.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
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

  it.effect("discovers a live service-private runtime state file", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-service-"));
        const serviceStatePath = NodePath.join(baseDir, "service", "runtime-state.json");
        yield* writeRuntimeState({ baseDir, origin, statePath: serviceStatePath });

        const target = yield* discoverPairTargetFromCandidates([
          {
            baseDir,
            variant: "userdata",
            statePath: serviceStatePath,
            source: "service",
          },
        ]);

        expect(target.source).toBe("service");
        expect(target.statePath).toBe(serviceStatePath);
        expect(target.descriptor.environmentId).toBe("pair-test-environment");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
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
        yield* writeRuntimeState({ baseDir, origin });
        const symlinkBaseDir = `${baseDir}-symlink`;
        NodeFS.symlinkSync(baseDir, symlinkBaseDir);

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", symlinkBaseDir, "--ttl", "1h", "--label", "Test phone"]),
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
        yield* writeRuntimeState({ baseDir: secondBaseDir, origin });
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

  it.effect("rejects runtime state owned by a stale PID", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stale-"));
      yield* writeRuntimeState({
        baseDir,
        origin: "http://127.0.0.1:1",
        pid: 4_194_305,
      });

      const error = yield* runCli(["pair", "--base-dir", baseDir]).pipe(
        Effect.flip,
        Effect.provide(CliRuntimeLayer),
      );
      expect(String(error)).toContain("NoRunningServerError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a live PID whose recorded endpoint is unreachable", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-unreachable-"));
      yield* writeRuntimeState({
        baseDir,
        origin: "http://127.0.0.1:1",
        pid: process.pid,
      });

      const error = yield* runCli(["pair", "--base-dir", baseDir]).pipe(
        Effect.flip,
        Effect.provide(CliRuntimeLayer),
      );
      expect(String(error)).toContain("NoRunningServerError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("verifies the exact public direct URL and skips wrong or unreachable candidates", () =>
    withDescriptorServer(
      (wrongOrigin) =>
        withDescriptorServer((matchingOrigin) =>
          Effect.gen(function* () {
            const target = {
              baseDir: "/tmp/pair-direct-verification",
              variant: "userdata" as const,
              statePath: "/tmp/pair-direct-verification/runtime.json",
              source: "foreground" as const,
              state: {
                version: 1 as const,
                pid: process.pid,
                port: Number(new URL(matchingOrigin).port),
                origin: matchingOrigin,
                startedAt: "2026-08-01T00:00:00.000Z",
                host: "0.0.0.0",
              },
              descriptor: {
                environmentId: EnvironmentId.make("pair-test-environment"),
                label: "Pair test",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
            } as const;

            expect(
              yield* resolveVerifiedDirectPairingBase({
                target,
                candidates: ["http://127.0.0.1:1", wrongOrigin, matchingOrigin],
              }),
            ).toBe(matchingOrigin);
            const failure = yield* resolveVerifiedDirectPairingBase({
              target,
              candidates: ["http://127.0.0.1:1", wrongOrigin],
            }).pipe(Effect.flip);
            expect(failure).toBeInstanceOf(PairingEndpointUnavailableError);
          }),
        ),
      "wrong-environment",
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it("ignores virtual, VPN, and link-local interfaces when selecting public candidates", () => {
    expect(
      resolveDirectPairingBaseUrlCandidates(
        {
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-08-01T00:00:00.000Z",
          host: "0.0.0.0",
        },
        {
          en0: [
            {
              address: "192.168.1.20",
              netmask: "255.255.255.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "192.168.1.20/24",
            },
            {
              address: "2001:db8::20",
              netmask: "ffff:ffff:ffff:ffff::",
              family: "IPv6",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "2001:db8::20/64",
              scopeid: 0,
            },
          ],
          bridge0: [
            {
              address: "172.20.0.1",
              netmask: "255.255.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "172.20.0.1/16",
            },
          ],
          utun4: [
            {
              address: "100.64.0.2",
              netmask: "255.192.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "100.64.0.2/10",
            },
          ],
          wg0: [
            {
              address: "10.8.0.2",
              netmask: "255.255.255.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "10.8.0.2/24",
            },
          ],
          "br-docker": [
            {
              address: "172.21.0.1",
              netmask: "255.255.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "172.21.0.1/16",
            },
          ],
          en1: [
            {
              address: "169.254.10.2",
              netmask: "255.255.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "169.254.10.2/16",
            },
          ],
        },
      ),
    ).toEqual(["http://192.168.1.20:3773", "http://localhost:3773"]);
  });

  it.effect("does not mint when the printed direct URL cannot be verified", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-public-"));
        yield* writeRuntimeState({ baseDir, origin, devUrl: "http://127.0.0.1:1" });

        yield* runCli(["pair", "--base-dir", baseDir]).pipe(
          Effect.flip,
          Effect.provide(CliRuntimeLayer),
        );
        const listed = JSON.parse(
          yield* captureStdout(
            runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
          ),
        ) as ReadonlyArray<unknown>;
        expect(listed).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back only newly created Serve mappings on downstream failures", () => {
    const commands: ReadonlyArray<string>[] = [];
    const spawner = makeProcessSpawnerLayer((args) => {
      commands.push(args);
      return {};
    });
    const created = {
      baseUrl: "https://desktop.tail.ts.net/",
      notes: [],
      createdServePort: 8443,
    };
    return Effect.gen(function* () {
      for (const failure of [
        new ServesOtherEnvironmentError({ servePort: 8443 }),
        new TailscaleEndpointVerificationError({
          servePort: 8443,
          outcome: "not-a-t3-server",
        }),
        new TailscaleEndpointVerificationError({ servePort: 8443, outcome: "unreachable" }),
        new Error("credential mint failed"),
        new Error("output failed"),
      ]) {
        yield* useResolvedPairingBase(created, Effect.fail(failure), (servePort) =>
          disableTailscaleServe({ servePort }),
        ).pipe(Effect.flip);
      }
      yield* useResolvedPairingBase(
        { baseUrl: created.baseUrl, notes: [] },
        Effect.fail(new Error("reused mapping failure")),
        (servePort) => disableTailscaleServe({ servePort }),
      ).pipe(Effect.flip);

      expect(commands).toEqual([
        ["serve", "--https=8443", "off"],
        ["serve", "--https=8443", "off"],
        ["serve", "--https=8443", "off"],
        ["serve", "--https=8443", "off"],
        ["serve", "--https=8443", "off"],
      ]);
    }).pipe(Effect.provide(spawner));
  });

  it.effect("rejects and rolls back mismatched, non-T3, and unreachable confirmations", () => {
    const cleanupPorts: number[] = [];
    const resolved = {
      baseUrl: "https://desktop.tail.ts.net/",
      notes: [],
      createdServePort: 8443,
    } as const;
    const descriptor = {
      environmentId: EnvironmentId.make("other-environment"),
      label: "Other",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: true },
    } as const;
    return Effect.gen(function* () {
      for (const outcome of [
        { _tag: "descriptor", descriptor } as const,
        { _tag: "not-a-t3-server" } as const,
        { _tag: "unreachable" } as const,
      ]) {
        yield* confirmNewTailscaleMapping({
          resolved,
          environmentId: "pair-test-environment",
          probe: () => Effect.succeed(outcome),
          cleanup: (servePort) =>
            Effect.sync(() => {
              cleanupPorts.push(servePort);
            }),
        }).pipe(Effect.flip);
      }
      expect(cleanupPorts).toEqual([8443, 8443, 8443]);
    }).pipe(Effect.provide(Layer.merge(CliRuntimeLayer, FetchHttpClient.layer)));
  });

  it.effect("surfaces exact cleanup guidance when Serve rollback fails", () => {
    return Effect.gen(function* () {
      const error = yield* confirmNewTailscaleMapping({
        resolved: {
          baseUrl: "https://desktop.tail.ts.net/",
          notes: [],
          createdServePort: 9443,
        },
        environmentId: "pair-test-environment",
        probe: () => Effect.succeed({ _tag: "not-a-t3-server" }),
        cleanup: () => Effect.fail(new Error("cleanup failed")),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PairingCleanupFailedError);
      expect(String(error)).toContain("tailscale serve --https=9443 off");
    }).pipe(Effect.provide(Layer.merge(CliRuntimeLayer, FetchHttpClient.layer)));
  });

  it("does not expose credential secrets in cleanup failure guidance", () => {
    const error = new PairingCredentialCleanupFailedError({
      pairingLinkId: "pairing-link-id",
      baseDir: "/tmp/base dir",
      primaryCause: new Error("output failed"),
      cleanupCause: new Error("revoke failed"),
    });

    expect(error.message).toContain(
      'npx t3 auth pairing revoke pairing-link-id --base-dir "/tmp/base dir"',
    );
    expect(error.message).not.toContain("one-time-secret");
  });
});
