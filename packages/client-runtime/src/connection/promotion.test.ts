import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { selectPromotionCandidates } from "./promotion.ts";

const environmentId = EnvironmentId.make("environment-promotion-test");

function endpoint(
  overrides: Partial<{
    id: string;
    httpBaseUrl: string;
    wsBaseUrl: string;
    reachability: "lan" | "private-network" | "loopback" | "public";
    status: "available" | "unavailable" | "unknown";
    providerKind: "core" | "private-network" | "tunnel" | "manual";
  }> = {},
) {
  return {
    id: overrides.id ?? "lan-main",
    label: "Environment",
    provider: {
      id: "provider",
      label: "Provider",
      kind: overrides.providerKind ?? "core",
      isAddon: false,
    },
    httpBaseUrl: overrides.httpBaseUrl ?? "https://192.168.1.20:3773",
    wsBaseUrl: overrides.wsBaseUrl ?? "wss://192.168.1.20:3773/ws",
    reachability: overrides.reachability ?? "lan",
    compatibility: {
      hostedHttpsApp: "compatible" as const,
      desktopApp: "compatible" as const,
    },
    source: "server" as const,
    status: overrides.status ?? "available",
    environmentId,
  };
}

describe("selectPromotionCandidates", () => {
  it("prefers LAN over private-network endpoints and removes duplicates by route", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "https://relay.example.test",
      endpoints: [
        endpoint({
          id: "tailscale",
          reachability: "private-network",
          providerKind: "private-network",
          httpBaseUrl: "https://host.tailnet.ts.net",
          wsBaseUrl: "wss://host.tailnet.ts.net/ws",
        }),
        endpoint({
          id: "lan",
          httpBaseUrl: "https://192.168.1.20:3773",
          wsBaseUrl: "wss://192.168.1.20:3773/ws",
        }),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["lan", "tailscale"]);
  });

  it("rejects public, loopback, unavailable, duplicate-current, and HTTPS downgrade candidates", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "https://relay.example.test",
      endpoints: [
        endpoint({ id: "public", reachability: "public" }),
        endpoint({ id: "loopback", reachability: "loopback" }),
        endpoint({ id: "unavailable", status: "unavailable" }),
        endpoint({
          id: "current",
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
        }),
        endpoint({
          id: "plaintext",
          httpBaseUrl: "http://192.168.1.20:3773",
          wsBaseUrl: "ws://192.168.1.20:3773/ws",
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("honors endpoint cooldowns without suppressing other candidates", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "http://relay.example.test",
      cooldownEndpointIds: new Set(["lan"]),
      endpoints: [
        endpoint({ id: "lan" }),
        endpoint({
          id: "tailscale",
          reachability: "private-network",
          providerKind: "private-network",
          httpBaseUrl: "https://host.tailnet.ts.net",
          wsBaseUrl: "wss://host.tailnet.ts.net/ws",
        }),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["tailscale"]);
  });
});
