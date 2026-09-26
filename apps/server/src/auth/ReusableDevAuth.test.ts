import { describe, expect, it } from "vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";

const TOKEN = "reusable-dev-auth-token-that-is-long-enough";

describe("resolveReusableDevAuth", () => {
  it("resolves a reusable credential for web-mode dev servers", () => {
    const devAuth = resolveReusableDevAuth({
      mode: "web",
      devUrl: new URL("http://localhost:5733"),
      devAuthToken: Redacted.make(TOKEN),
    });

    expect(devAuth).toBeDefined();
    expect(devAuth?.credential).toBe(TOKEN);
    expect(devAuth?.sessionId.startsWith(REUSABLE_DEV_SESSION_PREFIX)).toBe(true);
    expect(devAuth?.cookieName.startsWith("t3_dev_session_")).toBe(true);
    expect(devAuth?.matches(TOKEN)).toBe(true);
    expect(devAuth?.matches(`${TOKEN}-rotated`)).toBe(false);
    expect(devAuth?.matches("")).toBe(false);
  });

  it("derives stable session and cookie names per token value", () => {
    const first = resolveReusableDevAuth({
      mode: "web",
      devUrl: new URL("http://localhost:5733"),
      devAuthToken: Redacted.make(TOKEN),
    });
    const second = resolveReusableDevAuth({
      mode: "web",
      devUrl: new URL("http://localhost:9999"),
      devAuthToken: Redacted.make(TOKEN),
    });

    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.cookieName).toBe(first?.cookieName);
  });

  it("ignores desktop mode, non-dev servers, and empty tokens", () => {
    const devUrl = new URL("http://localhost:5733");
    expect(
      resolveReusableDevAuth({ mode: "desktop", devUrl, devAuthToken: Redacted.make(TOKEN) }),
    ).toBeUndefined();
    expect(
      resolveReusableDevAuth({
        mode: "web",
        devUrl: undefined,
        devAuthToken: Redacted.make(TOKEN),
      }),
    ).toBeUndefined();
    expect(
      resolveReusableDevAuth({ mode: "web", devUrl, devAuthToken: undefined }),
    ).toBeUndefined();
    expect(
      resolveReusableDevAuth({ mode: "web", devUrl, devAuthToken: Redacted.make("") }),
    ).toBeUndefined();
  });

  it("pins the far-future expiry required by the session schema", () => {
    expect(DateTime.formatIso(REUSABLE_DEV_SESSION_EXPIRES_AT)).toBe("9999-12-31T23:59:59.999Z");
  });
});
