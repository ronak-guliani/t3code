import { describe, expect, it } from "vitest";

import { resolveActiveAppOrigin } from "./threadUrl.ts";

describe("resolveActiveAppOrigin", () => {
  it("prefers the active Vite origin in development", () => {
    expect(
      resolveActiveAppOrigin({
        devUrl: new URL("http://127.0.0.1:5173/some-path"),
        host: "0.0.0.0",
        port: 3773,
      }),
    ).toBe("http://127.0.0.1:5173");
  });

  it("derives the production app origin from the active server binding", () => {
    expect(
      resolveActiveAppOrigin({
        devUrl: undefined,
        host: "code.internal",
        port: 8443,
      }),
    ).toBe("http://code.internal:8443");
  });
});
