import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const keyringLoad = vi.hoisted(() => vi.fn());
vi.mock("@napi-rs/keyring", () => {
  keyringLoad();
  throw new Error("Cannot find native binding");
});

import { resolveChromiumKeys } from "./ChromiumKeys.ts";

describe("unavailable native keyring", () => {
  it("loads the browser import module without loading the native binding", () => {
    expect(keyringLoad).not.toHaveBeenCalled();
  });

  it("does not load the macOS binding for Linux fallback keys", async () => {
    const keys = await Effect.runPromise(
      resolveChromiumKeys({
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: undefined,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(keys.cbcV10).toHaveLength(16);
    expect(keyringLoad).not.toHaveBeenCalled();
  });

  it("reports a typed import failure instead of crashing when the binding is missing", async () => {
    const error = await Effect.runPromise(
      resolveChromiumKeys({
        platform: "darwin",
        keychainService: "fixture-service",
        keychainAccount: "fixture-account",
        linuxSecretApplication: undefined,
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
    expect(error).toMatchObject({
      _tag: "ChromiumKeyError",
      reason: "keychainUnavailable",
    });
    expect(keyringLoad).toHaveBeenCalledOnce();
  });
});
