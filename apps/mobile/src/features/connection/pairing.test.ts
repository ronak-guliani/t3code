import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for bare IPv4 and IPv6 literals", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/pair#token=pairing-token",
    );
    expect(buildPairingUrl("[fd7a:115c:a1e0::1]:3773", "pairing-token")).toBe(
      "http://[fd7a:115c:a1e0::1]:3773/pair#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for named hosts", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/pair#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it.each(["t3code", "t3code-rg", "t3code-rg-dev", "t3code-rg-preview"])(
    "unwraps %s links that carry an encoded pairing url",
    (scheme) => {
      expect(
        extractPairingUrlFromQrPayload(
          `${scheme}://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token`,
        ),
      ).toBe("https://remote.example.com/pair#token=pairing-token");
    },
  );

  it("does not unwrap unrelated application links", () => {
    const payload = "other-app://pair?pairingUrl=https%3A%2F%2Fremote.example.com";
    expect(extractPairingUrlFromQrPayload(payload)).toBe(payload);
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
