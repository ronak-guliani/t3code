import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  make,
  parseLaunchctlState,
  renderLaunchAgent,
  resolvePackagedDist,
  servicePaths,
  type ServiceHost,
  type ServicePlan,
} from "./bootService.ts";
import type { ProcessRunResult } from "../processRunner.ts";

const result = (code = 0, stdout = "", stderr = ""): ProcessRunResult => ({
  code,
  stdout,
  stderr,
  signal: null,
  timedOut: false,
});

const makeHost = () => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const canonical = new Map<string, string>();
  const modes = new Map<string, number>();
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let loaded = false;
  let disabled = false;
  let pid = 0;
  let probe = true;
  let failCopy = false;
  const host: ServiceHost = {
    canonicalize: async (path) => canonical.get(path) ?? path,
    exists: async (path) => files.has(path) || directories.has(path),
    read: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeAtomic: async (path, contents, mode) => {
      files.set(path, contents);
      modes.set(path, mode);
    },
    makeDirectory: async (path, mode) => {
      directories.add(path);
      modes.set(path, mode);
    },
    listDirectory: async (path) =>
      [...directories]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => entry.slice(path.length + 1).split("/")[0]!)
        .filter((entry, index, entries) => entries.indexOf(entry) === index),
    copyDirectory: async (_source, destination) => {
      if (failCopy) throw new Error("copy failed");
      directories.add(destination);
      files.set(`${destination}/bin.mjs`, "bundle");
      files.set(`${destination}/client/index.html`, "client");
    },
    rename: async (source, destination) => {
      const value = files.get(source);
      if (value !== undefined) files.set(destination, value);
      files.delete(source);
    },
    remove: async (path, recursive) => {
      files.delete(path);
      directories.delete(path);
      if (recursive) {
        for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
        for (const key of directories) if (key.startsWith(`${path}/`)) directories.delete(key);
      }
    },
    chmod: async (path, mode) => {
      modes.set(path, mode);
      directories.add(path);
    },
    run: async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "print") {
        return loaded
          ? result(0, `state = ${pid > 0 ? "running" : "waiting"}\npid = ${pid}\n`)
          : result(113);
      }
      if (args[0] === "print-disabled") {
        return result(0, disabled ? `"${args[1]}" => true\n` : "");
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") {
        loaded = false;
        pid = 0;
      }
      if (args[0] === "kickstart") {
        loaded = true;
        pid = 4321;
      }
      if (args[0] === "disable") disabled = true;
      if (args[0] === "enable") disabled = false;
      return result();
    },
    probeRuntime: async () => probe,
  };
  return {
    host,
    files,
    directories,
    canonical,
    modes,
    commands,
    setProbe: (value: boolean) => {
      probe = value;
    },
    setFailCopy: (value: boolean) => {
      failCopy = value;
    },
  };
};

const seedPackage = (fake: ReturnType<typeof makeHost>, realEntry: string) => {
  fake.files.set(realEntry, "bundle");
  fake.files.set(`${realEntry.slice(0, -"/bin.mjs".length)}/client/index.html`, "client");
};

it("resolves symlinked npm and Bun bin entrypoints to packaged dist assets", async () => {
  for (const link of ["/Users/me/.npm/bin/t3", "/Users/me/.bun/bin/t3"]) {
    const fake = makeHost();
    const realEntry = "/opt/t3/node_modules/t3/dist/bin.mjs";
    fake.canonical.set(link, realEntry);
    seedPackage(fake, realEntry);
    assert.deepEqual(await Effect.runPromise(resolvePackagedDist(link, fake.host)), {
      entryPath: realEntry,
      distDir: "/opt/t3/node_modules/t3/dist",
    });
  }
});

it.effect("rejects transient and incomplete runtime layouts", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const transient = "/Users/me/.bun/install/cache/t3/dist/bin.mjs";
    fake.files.set(transient, "bundle");
    assert.equal(
      (yield* resolvePackagedDist(transient, fake.host).pipe(Effect.flip))._tag,
      "BootServiceError",
    );
    assert.equal(
      (yield* resolvePackagedDist("/repo/apps/server/src/bin.ts", fake.host).pipe(Effect.flip))
        ._tag,
      "BootServiceError",
    );
  }),
);

it("derives isolated launchd targets and paths from canonical base directories", () => {
  const first = servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data/one", userId: 501 });
  const second = servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data/two", userId: 501 });
  assert.notEqual(first.instanceId, second.instanceId);
  assert.notEqual(first.target, second.target);
  assert.notEqual(first.definitionPath, second.definitionPath);
  assert.notEqual(first.instanceDir, second.instanceDir);
  assert.isTrue(first.instanceDir.startsWith("/data/one/runtime/background-service/"));
  assert.isTrue(second.instanceDir.startsWith("/data/two/runtime/background-service/"));
});

it("renders escaped private LaunchAgents with service-only startup", () => {
  const paths = servicePaths({
    homeDir: "/Users/me",
    canonicalBaseDir: "/Users/me/T3 & Data",
    userId: 501,
  });
  const plan: ServicePlan = {
    ...paths,
    baseDir: "/Users/me/T3 & Data",
    runtimePath: `${paths.runtimesDir}/1/dist/bin.mjs`,
    arguments: ["/usr/bin/node", `${paths.runtimesDir}/1/dist/bin.mjs`, "serve"],
    environment: {
      T3CODE_HOME: "/Users/me/T3 & Data",
      T3CODE_BACKGROUND_SERVICE: "true",
      T3CODE_SERVICE_CWD: "/Users/me/code",
    },
  };
  const plist = renderLaunchAgent(plan);
  assert.include(plist, "/Users/me/T3 &amp; Data");
  assert.include(plist, "<key>Umask</key>\n  <integer>63</integer>");
  assert.include(plist, "<key>T3CODE_BACKGROUND_SERVICE</key>");
});

it("distinguishes a loaded job from a live process", () => {
  assert.deepEqual(parseLaunchctlState("state = waiting\n"), {
    loaded: true,
    processAlive: false,
  });
  assert.deepEqual(parseLaunchctlState("state = running\npid = 123\n"), {
    loaded: true,
    processAlive: true,
    pid: 123,
  });
});

it.effect("installs, health-checks, isolates, and completely uninstalls instances", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const first = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: { PATH: "/usr/bin:/bin" },
    });
    const second = yield* make({
      baseDir: "/data/two",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });

    yield* first.install({ cwd: "/Users/me/code", host: "127.0.0.1", port: 13_773 });
    yield* second.install({ cwd: "/Users/me/other", port: 13_774 });
    const firstStatus = yield* first.status;
    const secondStatus = yield* second.status;
    assert.isTrue(firstStatus.responsive);
    assert.notEqual(firstStatus.target, secondStatus.target);
    assert.equal(fake.modes.get(firstStatus.definitionPath), 0o600);
    assert.equal(fake.modes.get(firstStatus.instanceDir), 0o700);
    assert.equal(fake.modes.get(firstStatus.logPath), 0o600);

    fake.files.delete(firstStatus.definitionPath);
    assert.isTrue(yield* first.uninstall);
    assert.isFalse(fake.directories.has(firstStatus.instanceDir));
    assert.isTrue(fake.files.has(secondStatus.definitionPath));
    assert.isFalse(yield* first.uninstall);
  }),
);

it.effect("fails install when launchd has no live responsive process and rolls back", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const service = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });
    yield* service.install({ cwd: "/Users/me/code", port: 13_773 });
    const previous = yield* service.status;
    const previousDefinition = fake.files.get(previous.definitionPath);
    fake.setProbe(false);
    assert.equal(
      (yield* service.install({ cwd: "/Users/me/code", port: 13_773 }).pipe(Effect.flip))._tag,
      "BootServiceError",
    );
    assert.equal(fake.files.get(previous.definitionPath), previousDefinition);
  }),
);

it.effect("preserves the active service when candidate copying fails", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const service = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });
    yield* service.install({ cwd: "/Users/me/code" });
    const before = yield* service.status;
    const definition = fake.files.get(before.definitionPath);
    fake.setFailCopy(true);
    yield* service.install({ cwd: "/Users/me/code" }).pipe(Effect.flip);
    assert.equal(fake.files.get(before.definitionPath), definition);
    assert.isTrue((yield* service.status).processAlive);
  }),
);

it.effect("explicitly defers Linux and Windows", () =>
  Effect.gen(function* () {
    for (const platform of ["linux", "win32"] as const) {
      const service = yield* make({
        baseDir: "/data/one",
        host: makeHost().host,
        platform,
        homeDir: "/home/me",
        userId: 1000,
        executablePath: "/usr/bin/node",
        cliEntryPath: "/opt/t3/dist/bin.mjs",
        processEnvironment: {},
      });
      assert.isFalse((yield* service.status).supported);
      assert.equal(
        (yield* service.install({ cwd: "/data" }).pipe(Effect.flip))._tag,
        "BootServiceUnsupportedError",
      );
    }
  }),
);

it.effect("respects an explicitly unavailable macOS user id", () =>
  Effect.gen(function* () {
    const service = yield* make({
      baseDir: "/data/one",
      host: makeHost().host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: null,
      executablePath: "/usr/bin/node",
      cliEntryPath: "/Applications/T3/dist/bin.mjs",
      processEnvironment: {},
    });
    assert.isFalse((yield* service.status).supported);
  }),
);
