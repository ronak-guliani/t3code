import { describe, expect, it } from "vitest";

import { parsePairingCredential } from "./pairingUrl";

describe("parsePairingCredential", () => {
  const origin = "http://localhost:5733";

  it.each([
    [" secret ", "secret"],
    [`${origin}/pair#token=secret`, "secret"],
    [`${origin}/pair?token=secret`, "secret"],
    [`${origin}/pair#token=a%2Bb`, "a+b"],
  ])("accepts tokens and same-environment links", (input, expected) => {
    expect(parsePairingCredential(input, origin)).toBe(expected);
  });

  it.each([`${origin}/pair?token=`, `${origin}/pair#token=`])(
    "gives format-neutral guidance for an empty link token",
    (input) => {
      expect(() => parsePairingCredential(input, origin)).toThrow(
        "This pairing link must use the /pair path and contain a one-time token.",
      );
    },
  );

  it.each([
    "",
    "two tokens",
    "/pair#token=secret",
    "file:///pair#token=secret",
    "http://localhost:5734/pair#token=secret",
    `${origin}/pair`,
    `${origin}/settings#token=secret`,
    "http://user:password@localhost:5733/pair#token=secret",
  ])("rejects malformed or wrong-environment input without echoing secrets", (input) => {
    expect(() => parsePairingCredential(input, origin)).toThrow();
    try {
      parsePairingCredential(input, origin);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
