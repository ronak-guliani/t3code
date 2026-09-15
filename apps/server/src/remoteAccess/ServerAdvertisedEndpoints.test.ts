import { describe, expect, it } from "vitest";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  resolveVerifiedTailscaleServeEndpoints,
  resolveServerAdvertisedEndpoints,
  resolveTailscaleEndpoints,
  type LiveListener,
} from "./ServerAdvertisedEndpoints.ts";

const listener = (host: string, family: LiveListener["family"] = "IPv4"): LiveListener => ({
  host,
  family,
  port: 13773,
});

describe("resolveTailscaleEndpoints", () => {
  const runDiscovery = async (
    liveListener: LiveListener,
    serve: { readonly stdout: string; readonly code?: number },
  ) => {
    const commands: ReadonlyArray<string>[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die("Expected a standard Tailscale command");
      }
      commands.push(command.args);
      const result =
        command.args[0] === "serve"
          ? serve
          : { stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }) };
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(result.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: "environment-a",
            label: "Host",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0",
            capabilities: {},
          }),
        ),
      ),
    );
    const endpoints = await Effect.runPromise(
      resolveTailscaleEndpoints({
        listener: liveListener,
        networkInterfaces: {
          utun0: [{ address: "100.64.0.4", family: "IPv4", internal: false }],
        },
        environmentId: "environment-a",
        client,
        spawner,
      }),
    );
    expect(commands).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
    return endpoints.map((value) => value.httpBaseUrl);
  };

  it("inspects verified Serve mappings for IPv6 loopback without synthesizing IPv4 routes", async () => {
    expect(
      await runDiscovery(listener("::1", "IPv6"), {
        stdout: JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "host.tailnet.ts.net:443": {
              Handlers: { "/": { Proxy: "http://[::1]:13773" } },
            },
          },
        }),
      }),
    ).toEqual(["https://host.tailnet.ts.net/"]);
  });

  it.each([{ stdout: "", code: 1 }, { stdout: "{invalid-json" }])(
    "retains Tailnet IP discovery when optional Serve inspection fails: %j",
    async (serve) => {
      expect(await runDiscovery(listener("0.0.0.0"), serve)).toEqual(["http://100.64.0.4:13773/"]);
    },
  );
});

const interfaces = {
  en0: [
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "10.0.0.8", family: "IPv4", internal: false },
    { address: "169.254.10.4", family: "IPv4", internal: false },
    { address: "127.0.0.1", family: "IPv4", internal: true },
  ],
  bridge0: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
  en0v6: [
    { address: "fd12::20", family: "IPv6", internal: false },
    { address: "fe80::20", family: "IPv6", internal: false },
  ],
};

const endpoint = (
  httpBaseUrl: string,
  reachability: "private-network" | "public" = "private-network",
) =>
  createAdvertisedEndpoint({
    id: `fixture:${httpBaseUrl}`,
    label: "Fixture",
    provider: {
      id: "tailscale",
      label: "Tailscale",
      kind: "private-network",
      isAddon: true,
    },
    source: "server",
    httpBaseUrl,
    reachability,
    status: "available",
    ...(httpBaseUrl.startsWith("https:")
      ? { hostedHttpsCompatibility: "compatible" as const }
      : {}),
  });

describe("resolveServerAdvertisedEndpoints", () => {
  it("uses the live ephemeral port and enumerates only same-family wildcard interfaces", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      listener: { host: "0.0.0.0", family: "IPv4", port: 43127 },
      networkInterfaces: interfaces,
    });

    expect(endpoints.map((value) => value.httpBaseUrl)).toEqual([
      "http://127.0.0.1:43127/",
      "http://192.168.1.20:43127/",
      "http://10.0.0.8:43127/",
      "http://172.18.0.1:43127/",
    ]);
  });

  it("keeps IPv6 wildcard discovery separate and excludes link-local addresses", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      listener: listener("::", "IPv6"),
      networkInterfaces: interfaces,
    });

    expect(endpoints.map((value) => value.httpBaseUrl)).toEqual([
      "http://[::1]:13773/",
      "http://[fd12::20]:13773/",
    ]);
  });

  it("does not fabricate LAN endpoints for loopback or invalid specific binds", () => {
    expect(
      resolveServerAdvertisedEndpoints({
        listener: listener("127.0.0.1"),
        networkInterfaces: interfaces,
      }).map((value) => value.httpBaseUrl),
    ).toEqual(["http://127.0.0.1:13773/"]);

    expect(
      resolveServerAdvertisedEndpoints({
        listener: listener("169.254.10.4"),
        networkInterfaces: interfaces,
      }),
    ).toEqual([]);

    expect(
      resolveServerAdvertisedEndpoints({
        listener: listener("::1", "IPv6"),
        networkInterfaces: interfaces,
      }).map((value) => value.httpBaseUrl),
    ).toEqual(["http://[::1]:13773/"]);
  });

  it("advertises only a usable specific IPv6 bind", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      listener: listener("fd12::20", "IPv6"),
      networkInterfaces: interfaces,
    });

    expect(endpoints.map((value) => value.httpBaseUrl)).toEqual(["http://[fd12::20]:13773/"]);
  });

  it("accepts verified Serve HTTPS routes for loopback listeners but not plain Tailscale IPs", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      listener: listener("127.0.0.1"),
      networkInterfaces: interfaces,
      tailscaleEndpoints: [
        endpoint("http://100.64.0.4:13773"),
        endpoint("https://host.tailnet.ts.net:443"),
      ],
    });

    expect(endpoints.map((value) => value.httpBaseUrl)).toEqual([
      "http://127.0.0.1:13773/",
      "https://host.tailnet.ts.net/",
    ]);
  });

  it("requires exact listener identity for specific Tailscale IP binds", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      listener: listener("100.64.0.4"),
      networkInterfaces: interfaces,
      tailscaleEndpoints: [
        endpoint("http://100.64.0.4:13773"),
        endpoint("http://100.64.0.40:13773"),
      ],
    });

    expect(endpoints.map((value) => value.httpBaseUrl)).toEqual(["http://100.64.0.4:13773/"]);
  });
});

describe("resolveVerifiedTailscaleServeEndpoints", () => {
  const serveListener = listener("127.0.0.1");
  const matchingMapping = {
    magicDnsName: "host.tailnet.ts.net",
    servePort: 443,
    target: "http://127.0.0.1:13773",
  };

  const runWithResponse = (status: number, environmentId: string) => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              environmentId,
              label: "Host",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0",
              capabilities: {},
            },
            { status },
          ),
        ),
      ),
    );
    return (mappings: readonly (typeof matchingMapping)[]) =>
      Effect.runPromise(
        resolveVerifiedTailscaleServeEndpoints({
          listener: serveListener,
          mappings,
          magicDnsName: "host.tailnet.ts.net",
          environmentId: "environment-a",
          client,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
  };

  it("accepts only matching Serve targets and environment identity", async () => {
    const resolve = runWithResponse(200, "environment-a");
    const endpoints = await resolve([
      matchingMapping,
      { ...matchingMapping, target: "http://127.0.0.1:13774" },
      { ...matchingMapping, target: "http://192.168.1.20:13773" },
      { ...matchingMapping, magicDnsName: "other.tailnet.ts.net" },
    ]);

    expect(endpoints.map((endpoint) => endpoint.httpBaseUrl)).toEqual([
      "https://host.tailnet.ts.net/",
    ]);
  });

  it("rejects mismatched identities, redirects, and failed probes", async () => {
    const mismatchedIdentity = await runWithResponse(200, "environment-b")([matchingMapping]);
    const redirected = await runWithResponse(302, "environment-a")([matchingMapping]);
    const unavailable = await runWithResponse(503, "environment-a")([matchingMapping]);

    expect(mismatchedIdentity).toEqual([]);
    expect(redirected).toEqual([]);
    expect(unavailable).toEqual([]);
  });
});
