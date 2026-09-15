import { describe, expect, it } from "vitest";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";

import {
  resolveServerAdvertisedEndpoints,
  type LiveListener,
} from "./ServerAdvertisedEndpoints.ts";

const listener = (host: string, family: LiveListener["family"] = "IPv4"): LiveListener => ({
  host,
  family,
  port: 13773,
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
      "http://127.0.0.1:13773/",
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
