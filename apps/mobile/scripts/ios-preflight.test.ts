import { describe, expect, it } from "vite-plus/test";
import { assertSupportedXcode } from "./ios-preflight.mts";

describe("iOS toolchain preflight", () => {
  it.each(["26.4", "26.6", "27.0"])("accepts supported Xcode %s", (version) => {
    expect(() => assertSupportedXcode(`Xcode ${version}\nBuild version 17F113\n`)).not.toThrow();
  });

  it.each(["16.4", "26.0.1", "26.3"])("rejects Xcode %s before native work", (version) => {
    expect(() => assertSupportedXcode(`Xcode ${version}\nBuild version 17A400\n`)).toThrow(
      "requires Xcode 26.4 or newer",
    );
  });

  it("does not assume a compatible toolchain when version discovery fails", () => {
    expect(() => assertSupportedXcode("xcode-select: developer tools not installed")).toThrow(
      "Could not read",
    );
  });
});
