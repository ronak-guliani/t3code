import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { resolveTailscaleAdvertisedEndpoints } from "./endpointProvider.ts";

const dependencies = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const resolve = (input: Parameters<typeof resolveTailscaleAdvertisedEndpoints>[0]) =>
  Effect.runPromise(resolveTailscaleAdvertisedEndpoints(input).pipe(Effect.provide(dependencies)));

const interfaces = {
  en0: [
    { address: "100.64.0.4", family: "IPv4", internal: false },
    { address: "100.64.0.4", family: "IPv4", internal: false },
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "100.64.0.5", family: "IPv4", internal: true },
    { address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false },
  ],
};

describe("resolveTailscaleAdvertisedEndpoints", () => {
  it("filters non-Tailscale addresses and deduplicates IPv4 candidates", async () => {
    const endpoints = await resolve({
      port: 13773,
      source: "server",
      networkInterfaces: interfaces,
      statusJson: "",
      probe: () => Effect.succeed(false),
    });

    expect(endpoints.map((endpoint) => endpoint.httpBaseUrl)).toEqual(["http://100.64.0.4:13773/"]);
  });

  it("propagates the endpoint source and uses explicit status JSON before the reader", async () => {
    let readerCalls = 0;
    const endpoints = await resolve({
      port: 13773,
      source: "desktop-core",
      networkInterfaces: interfaces,
      statusJson: JSON.stringify({
        Self: { DNSName: "desktop.tailnet.ts.net." },
      }),
      readMagicDnsName: Effect.sync(() => {
        readerCalls += 1;
        return "reader.tailnet.ts.net";
      }),
      serveEnabled: true,
      probe: () => Effect.succeed(true),
    });

    expect(readerCalls).toBe(0);
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((endpoint) => endpoint.source === "desktop-core")).toBe(true);
    expect(endpoints[1]?.httpBaseUrl).toBe("https://desktop.tailnet.ts.net/");
    expect(endpoints[1]?.status).toBe("available");
    expect(endpoints[1]?.compatibility.hostedHttpsApp).toBe("compatible");
  });

  it("reports MagicDNS Serve compatibility states without claiming availability", async () => {
    const disabled = await resolve({
      port: 13773,
      source: "server",
      networkInterfaces: {},
      statusJson: JSON.stringify({
        Self: { DNSName: "host.tailnet.ts.net." },
      }),
      serveEnabled: false,
      probe: () => Effect.succeed(true),
    });
    const failed = await resolve({
      port: 13773,
      source: "server",
      networkInterfaces: {},
      statusJson: JSON.stringify({
        Self: { DNSName: "host.tailnet.ts.net." },
      }),
      serveEnabled: true,
      probe: () => Effect.succeed(false),
    });

    expect(disabled[0]?.status).toBe("unavailable");
    expect(disabled[0]?.compatibility.hostedHttpsApp).toBe("requires-configuration");
    expect(failed[0]?.status).toBe("unavailable");
    expect(failed[0]?.compatibility.hostedHttpsApp).toBe("requires-configuration");
  });
});
