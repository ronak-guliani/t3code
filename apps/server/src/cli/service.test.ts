import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as BootService from "../cloud/bootService.ts";
import { serializeServiceInstallation } from "../cloud/serviceInstallation.ts";
import {
  ensureBackgroundService,
  formatServiceStatus,
  resolveBackgroundServiceAction,
  restartHealthyCurrentService,
} from "./service.ts";

const paths = BootService.servicePaths({
  homeDir: "/Users/me",
  canonicalBaseDir: "/data",
  userId: 501,
});

it("distinguishes installed definitions from a running service", () => {
  const text = formatServiceStatus({
    ...paths,
    supported: true,
    platform: "darwin",
    installed: true,
    enabled: true,
    loaded: true,
    processAlive: false,
    responsive: false,
    current: true,
  });
  assert.include(text, "Installed: yes");
  assert.include(text, "Process: not running");
  assert.include(text, "Current: yes");
});

it("reports unsupported platforms explicitly", () => {
  assert.include(
    formatServiceStatus({
      ...BootService.servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data", userId: 0 }),
      supported: false,
      platform: "win32",
      installed: false,
      enabled: false,
      loaded: false,
      processAlive: false,
      responsive: false,
      current: false,
    }),
    "unsupported on win32",
  );
});

it.effect("retains a healthy service on setup retries", () =>
  Effect.gen(function* () {
    let restarts = 0;
    const service = BootService.BootService.of({
      install: () => Effect.die("unexpected install"),
      status: Effect.succeed({
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: true,
        pid: 4321,
        current: true,
      }),
      start: Effect.die("unexpected start"),
      restart: Effect.sync(() => {
        restarts += 1;
      }),
      stop: Effect.die("unexpected stop"),
      enable: Effect.die("unexpected enable"),
      disable: Effect.die("unexpected disable"),
      uninstall: Effect.die("unexpected uninstall"),
    });

    assert.isTrue(
      yield* restartHealthyCurrentService(service, {
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: true,
        pid: 4321,
        current: true,
      }),
    );
    assert.equal(restarts, 0);
    assert.isTrue(yield* restartHealthyCurrentService(service, yield* service.status, true));
    assert.equal(restarts, 1);
  }),
);

it.effect("restarts a healthy service when local discovery state is stale", () =>
  Effect.gen(function* () {
    let restarts = 0;
    const service = BootService.BootService.of({
      install: () => Effect.die("unexpected install"),
      status: Effect.succeed({
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: true,
        pid: 4321,
        current: true,
      }),
      start: Effect.die("unexpected start"),
      restart: Effect.sync(() => {
        restarts += 1;
      }),
      stop: Effect.die("unexpected stop"),
      enable: Effect.die("unexpected enable"),
      disable: Effect.die("unexpected disable"),
      uninstall: Effect.die("unexpected uninstall"),
    });

    assert.strictEqual(
      yield* ensureBackgroundService({ restartRequired: true }).pipe(
        Effect.provideService(BootService.BootService, service),
      ),
      "restarted",
    );
    assert.equal(restarts, 1);
  }),
);

it.effect("installs a missing service during one-command remote setup", () =>
  Effect.gen(function* () {
    const installations: BootService.ServiceInvocation[] = [];
    const service = BootService.BootService.of({
      install: (invocation) =>
        Effect.sync(() => {
          installations.push(invocation);
          return {
            ...paths,
            baseDir: "/data",
            runtimePath: "/runtime",
            arguments: [],
            environment: {},
          };
        }),
      status: Effect.succeed({
        ...paths,
        supported: true,
        platform: "darwin",
        installed: false,
        enabled: false,
        loaded: false,
        processAlive: false,
        responsive: false,
        current: false,
      }),
      start: Effect.die("unexpected start"),
      restart: Effect.die("unexpected restart"),
      stop: Effect.die("unexpected stop"),
      enable: Effect.die("unexpected enable"),
      disable: Effect.die("unexpected disable"),
      uninstall: Effect.die("unexpected uninstall"),
    });

    assert.strictEqual(
      yield* ensureBackgroundService({ cwd: "/workspace" }).pipe(
        Effect.provideService(BootService.BootService, service),
      ),
      "installed",
    );
    assert.deepStrictEqual(installations, [{ cwd: "/workspace" }]);
  }),
);

it.effect("preserves installed service settings and applies explicit environment overrides", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-service-settings-"))),
    (root) =>
      Effect.gen(function* () {
        const savedInvocation = {
          cwd: "/saved/workspace",
          host: "127.0.0.2",
          port: 4555,
        };
        const installedPaths = BootService.servicePaths({
          homeDir: root,
          canonicalBaseDir: join(root, "data"),
          userId: 501,
        });
        yield* Effect.promise(async () => {
          await mkdir(dirname(installedPaths.versionPath), { recursive: true });
          await writeFile(
            installedPaths.versionPath,
            serializeServiceInstallation(savedInvocation),
            "utf8",
          );
        });

        const installations: BootService.ServiceInvocation[] = [];
        const service = BootService.BootService.of({
          install: (invocation) =>
            Effect.sync(() => {
              installations.push(invocation);
              return {
                ...installedPaths,
                baseDir: join(root, "data"),
                runtimePath: "/runtime",
                arguments: [],
                environment: {},
              };
            }),
          status: Effect.succeed({
            ...installedPaths,
            supported: true,
            platform: "darwin",
            installed: true,
            enabled: false,
            loaded: false,
            processAlive: false,
            responsive: false,
            current: true,
          }),
          start: Effect.die("unexpected start"),
          restart: Effect.die("unexpected restart"),
          stop: Effect.die("unexpected stop"),
          enable: Effect.die("unexpected enable"),
          disable: Effect.die("unexpected disable"),
          uninstall: Effect.die("unexpected uninstall"),
        });

        const previousHost = process.env.T3CODE_HOST;
        const previousPort = process.env.T3CODE_PORT;
        try {
          delete process.env.T3CODE_HOST;
          delete process.env.T3CODE_PORT;
          assert.strictEqual(
            yield* ensureBackgroundService().pipe(
              Effect.provideService(BootService.BootService, service),
            ),
            "repaired",
          );

          process.env.T3CODE_HOST = "0.0.0.0";
          process.env.T3CODE_PORT = "4666";
          assert.strictEqual(
            yield* ensureBackgroundService().pipe(
              Effect.provideService(BootService.BootService, service),
            ),
            "repaired",
          );
        } finally {
          if (previousHost === undefined) delete process.env.T3CODE_HOST;
          else process.env.T3CODE_HOST = previousHost;
          if (previousPort === undefined) delete process.env.T3CODE_PORT;
          else process.env.T3CODE_PORT = previousPort;
        }

        assert.deepStrictEqual(installations, [
          savedInvocation,
          { ...savedInvocation, host: "0.0.0.0", port: 4666 },
        ]);
      }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ),
);

it.effect("restarts an unresponsive current service during remote setup", () =>
  Effect.gen(function* () {
    let restarts = 0;
    const service = BootService.BootService.of({
      install: () => Effect.die("unexpected install"),
      status: Effect.succeed({
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: false,
        pid: 4321,
        current: true,
      }),
      start: Effect.die("unexpected start"),
      restart: Effect.sync(() => {
        restarts += 1;
      }),
      stop: Effect.die("unexpected stop"),
      enable: Effect.die("unexpected enable"),
      disable: Effect.die("unexpected disable"),
      uninstall: Effect.die("unexpected uninstall"),
    });

    assert.strictEqual(
      yield* ensureBackgroundService().pipe(
        Effect.provideService(BootService.BootService, service),
      ),
      "restarted",
    );
    assert.equal(restarts, 1);
  }),
);

it("repairs rather than restarts a disabled service with a live process", () => {
  assert.strictEqual(
    resolveBackgroundServiceAction({
      ...paths,
      supported: true,
      platform: "win32",
      installed: true,
      enabled: false,
      loaded: true,
      processAlive: true,
      responsive: false,
      pid: 4321,
      current: true,
    }),
    "install",
  );
});
