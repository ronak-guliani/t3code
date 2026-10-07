import { describe, expect, it } from "vitest";

import { isLoopbackHostname, parseAssetByteRange, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("asset byte ranges", () => {
  it.each([
    { range: "bytes=-100", size: 1_000, expected: { start: 900, end: 999 } },
    { range: "bytes=-100", size: 50, expected: { start: 0, end: 49 } },
    { range: "bytes=100-200", size: 150, expected: { start: 100, end: 149 } },
    { range: "bytes=100-", size: 150, expected: { start: 100, end: 149 } },
  ])("parses $range for a $size-byte file", ({ range, size, expected }) => {
    expect(parseAssetByteRange(range, size)).toEqual(expected);
  });

  it.each(["bytes=-0", "bytes=50-49", "bytes=150-", "items=0-10"])(
    "rejects unsatisfiable or invalid range %s",
    (range) => {
      expect(parseAssetByteRange(range, 50)).toBeNull();
    },
  );
});
