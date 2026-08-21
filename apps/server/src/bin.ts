import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { enableV8CompileCache } from "@t3tools/shared/compileCache";
import { cli } from "./cli.ts";
import { CliRuntimeLayerLive } from "./cliRuntime.ts";
import packageJson from "../package.json" with { type: "json" };

// Persist V8 bytecode so repeat launches skip recompiling the many external
// `node_modules` files this CLI/server loads. When spawned by the desktop app,
// `NODE_COMPILE_CACHE` is already set (covering first-run static imports too);
// this call is the fallback for standalone `t3` invocations.
enableV8CompileCache();

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayerLive),
  NodeRuntime.runMain,
);
