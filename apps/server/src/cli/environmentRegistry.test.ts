import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import {
  environmentCommandSelector,
  readEnvironmentRegistry,
  resolveEnvironmentCandidate,
  writeEnvironmentRegistry,
  type CliEnvironmentCandidate,
} from "./environmentRegistry.ts";

const manual = (
  id: string,
  label: string,
): Extract<CliEnvironmentCandidate, { readonly source: "manual" }> => ({
  source: "manual",
  id,
  label,
  profile: {
    id,
    label,
    url: `https://${id}.example.test`,
  },
});

const account = (
  id: string,
  label: string,
): Extract<CliEnvironmentCandidate, { readonly source: "account" }> => ({
  source: "account",
  id,
  label,
  accountId: "account-1",
  environment: {
    environmentId: EnvironmentId.make(id),
    label,
    endpoint: {
      httpBaseUrl: `https://${id}.example.test`,
      wsBaseUrl: `wss://${id}.example.test/ws`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-09-10T00:00:00.000Z",
  },
});

it("migrates a legacy manual current id to a typed selection", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-env-registry-"));
  try {
    await mkdir(baseDir, { recursive: true });
    await writeFile(
      join(baseDir, "cli-environments.json"),
      JSON.stringify({
        current: "desktop",
        environments: {
          desktop: {
            id: "desktop",
            label: "Desktop",
            url: "https://desktop.example.test",
          },
        },
      }),
    );

    const registry = await Effect.runPromise(
      readEnvironmentRegistry(Option.some(baseDir)).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.deepEqual(registry.current, { source: "manual", id: "desktop" });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("writes the typed registry with owner-only permissions", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-env-registry-mode-"));
  try {
    await Effect.runPromise(
      writeEnvironmentRegistry(Option.some(baseDir), {
        version: 2,
        current: { source: "manual", id: "desktop" },
        environments: {
          desktop: {
            id: "desktop",
            label: "Desktop",
            url: "https://desktop.example.test",
            token: "secret",
          },
        },
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    const path = join(baseDir, "cli-environments.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.include(await readFile(path, "utf8"), '"source": "manual"');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("removes the temporary registry file when persistence fails", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-env-registry-cleanup-"));
  try {
    await mkdir(join(baseDir, "cli-environments.json"));

    await Effect.runPromise(
      writeEnvironmentRegistry(Option.some(baseDir), {
        version: 2,
        environments: {
          desktop: {
            id: "desktop",
            label: "Desktop",
            url: "https://desktop.example.test",
            token: "secret",
          },
        },
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.isFalse((await readdir(baseDir)).some((entry) => entry.endsWith(".tmp")));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it.effect("preserves registry inspection failures instead of treating them as missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failingFileSystem = {
      ...fs,
      exists: (path: string) =>
        path.endsWith("cli-environments.json")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "exists",
                pathOrDescriptor: path,
                description: "Permission denied while inspecting registry.",
              }),
            )
          : fs.exists(path),
    } satisfies FileSystem.FileSystem;

    const error = yield* readEnvironmentRegistry(
      Option.some("/tmp/t3-cli-registry-permission-test"),
    ).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

    assert.include(error.message, "Could not inspect environment registry");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("keeps legacy environment ids manual and gives --environment precedence", () => {
  assert.deepEqual(
    environmentCommandSelector(Option.none(), Option.some("account:prod")),
    Option.some("manual:account:prod"),
  );
  assert.deepEqual(
    environmentCommandSelector(Option.some("account:prod"), Option.some("manual-profile")),
    Option.some("account:prod"),
  );
});

it("prefers stable ids and rejects ambiguous labels across sources", () => {
  const candidates = [manual("manual-id", "Desktop"), account("environment-id", "Desktop")];
  assert.equal(resolveEnvironmentCandidate("manual-id", candidates).source, "manual");
  assert.equal(resolveEnvironmentCandidate("environment-id", candidates).source, "account");
  assert.equal(resolveEnvironmentCandidate("manual:manual-id", candidates).source, "manual");
  assert.equal(resolveEnvironmentCandidate("account:environment-id", candidates).source, "account");
  assert.throws(
    () => resolveEnvironmentCandidate("Desktop", candidates),
    /ambiguous.*manual:manual-id, account:environment-id/i,
  );
});
