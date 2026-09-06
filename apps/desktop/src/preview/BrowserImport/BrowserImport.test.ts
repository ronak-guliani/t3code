import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { cookieScope } from "./CookieDatabase.ts";
import { decryptChromiumValue } from "./ChromiumCookies.ts";
import { parseBinaryCookies } from "./SafariCookies.ts";

function makeSafariCookieFixture(): Buffer {
  const domain = Buffer.from(".example.com\0");
  const name = Buffer.from("session\0");
  const path = Buffer.from("/\0");
  const value = Buffer.from("fixture-value\0");
  const recordSize = 56 + domain.length + name.length + path.length + value.length;
  const record = Buffer.alloc(recordSize);
  let offset = 56;

  record.writeUInt32LE(recordSize, 0);
  record.writeUInt32LE(0x1 | 0x4, 8);
  for (const [fieldOffset, bytes] of [
    [16, domain],
    [20, name],
    [24, path],
    [28, value],
  ] as const) {
    record.writeUInt32LE(offset, fieldOffset);
    bytes.copy(record, offset);
    offset += bytes.length;
  }

  const pageSize = 16 + record.length;
  const page = Buffer.alloc(pageSize);
  page.writeUInt32BE(0x100, 0);
  page.writeUInt32LE(1, 4);
  page.writeUInt32LE(16, 8);
  record.copy(page, 16);

  const fixture = Buffer.alloc(12 + page.length);
  fixture.write("cook", 0, "latin1");
  fixture.writeUInt32BE(1, 4);
  fixture.writeUInt32BE(page.length, 8);
  page.copy(fixture, 12);
  return fixture;
}

describe("browser cookie import primitives", () => {
  it("decrypts a synthetic Chromium v10 cookie without reading a real profile", () => {
    const key = Buffer.alloc(16, 7);
    const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update("fixture-value", "utf8"),
      cipher.final(),
    ]);

    expect(decryptChromiumValue(encrypted, { cbcV10: key }, ".example.com", 23, "darwin")).toBe(
      "fixture-value",
    );
  });

  it("parses a synthetic Safari binary cookie fixture", () => {
    expect(parseBinaryCookies(makeSafariCookieFixture())).toEqual([
      expect.objectContaining({
        url: "https://example.com/",
        domain: ".example.com",
        name: "session",
        value: "fixture-value",
        secure: true,
        httpOnly: true,
        path: "/",
      }),
    ]);
  });

  it("keeps host-only cookies narrow when preparing Electron cookie writes", () => {
    expect(cookieScope("example.com", "/", false)).toEqual({
      url: "http://example.com/",
      domain: undefined,
    });
    expect(cookieScope(".example.com", "/", true)).toEqual({
      url: "https://example.com/",
      domain: ".example.com",
    });
  });
});
