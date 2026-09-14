import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { deregisterAccountEnvironment, listAccountEnvironments } from "./accountEnvironments";

const token = `e30.${Buffer.from(JSON.stringify({ sub: "account-1" })).toString("base64url")}.test`;
const input = () => ({
  accountId: "account-1",
  token,
  relayUrl: "https://relay.example.test",
  signal: new AbortController().signal,
});

afterEach(() => vi.unstubAllGlobals());

describe("account environment management", () => {
  it("deregisters an offline host through the relay only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await deregisterAccountEnvironment({
      ...input(),
      environmentId: EnvironmentId.make("offline-host"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://relay.example.test/v1/client/environment-links/offline-host",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  });

  it("does not use another account's credential after a switch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deregisterAccountEnvironment({
        ...input(),
        accountId: "account-2",
        environmentId: EnvironmentId.make("host"),
      }),
    ).rejects.toThrow("account changed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains structured relay limit and trace diagnostics without inventing usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            _tag: "RelayEnvironmentLinkLimitExceededError",
            code: "environment_link_limit_exceeded",
            maxTunnels: 3,
            traceId: "trace-limit",
          },
          { status: 403 },
        ),
      ),
    );
    await expect(listAccountEnvironments(input())).rejects.toThrow(
      "at most 3 tunnels (Trace ID: trace-limit)",
    );
  });

  it("does not treat malformed discovery as an empty account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ environments: "invalid" })),
    );
    await expect(listAccountEnvironments(input())).rejects.toThrow("incompatible environment list");
  });

  it("does not report an unconfirmed delete as success", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false })));
    await expect(
      deregisterAccountEnvironment({ ...input(), environmentId: EnvironmentId.make("host") }),
    ).rejects.toThrow("did not confirm");
  });
});
