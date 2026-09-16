import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { DeviceHostError, DeviceHost } from "./DeviceHost.ts";
import { makeWithHosts } from "./DeviceService.ts";

const host = (id: string, failed = false): DeviceHost["Service"] => {
  const ready = {
    nodePath: process.execPath,
    hub: { origin: `http://${id}` },
    agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  return {
    id,
    summary: Effect.succeed({
      id,
      label: id,
      kind: id === "b" ? "ssh" : "local",
      hubInstalled: true,
      agentDeviceInstalled: true,
      platforms: id === "b" ? [] : [{ platform: "android", available: true }],
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () =>
      failed
        ? Effect.fail(
            new DeviceHostError({ hostId: id, step: "connect", cause: new Error("offline") }),
          )
        : Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed(ready),
    withCurrentAgent: (use) => use(ready),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
};
const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        simulators: [],
        emulators: [
          {
            id: "emulator-5554",
            name: "Pixel",
            version: "36",
            platform: "android",
            booted: true,
            physical: false,
          },
        ],
      }),
    ),
  ),
);

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* makeWithHosts(hosts, undefined, () =>
      Effect.gen(function* () {
        order.push("write started");
        yield* Deferred.succeed(writeStarted, undefined);
        yield* Deferred.await(finishWrite);
        order.push("write finished");
        return "/host-config.json";
      }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    const targeting = yield* service
      .agentTarget({ threadId, hostId: "b", deviceId: "emulator-5554" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    const slowStarted = yield* Deferred.make<void>();
    const finishSlow = yield* Deferred.make<void>();
    const slowHost = host("slow");
    hosts.set("slow", {
      ...slowHost,
      ensureReady: (onPhase) =>
        Deferred.succeed(slowStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishSlow)),
          Effect.andThen(slowHost.ensureReady(onPhase)),
        ),
    });
    const slowStart = yield* service.readiness("slow").pipe(Effect.forkChild);
    yield* Deferred.await(slowStarted);
    expect((yield* service.readiness("a")).hostId).toBe("a");
    yield* Deferred.succeed(finishSlow, undefined);
    yield* Fiber.join(slowStart);
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

it.effect("skips known unsupported SSH hosts without starting manual or agent tools", () =>
  Effect.gen(function* () {
    const unsupported = host("b");
    const service = yield* makeWithHosts(
      new Map([
        [
          unsupported.id,
          {
            ...unsupported,
            summary: unsupported.summary.pipe(
              Effect.map((summary) => ({
                ...summary,
                platforms: [{ platform: "android", available: false }],
              })),
            ),
            ensureReady: () => Effect.die("Unexpected startup on an unsupported host"),
            ensureAgentReady: () => Effect.die("Unexpected agent startup on an unsupported host"),
          },
        ],
      ]),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(yield* service.readinessIfSupported("b")).toBeNull();
    expect(yield* service.agentReadinessIfSupported("b")).toBeNull();
    expect((yield* service.list).hostStatuses.b).toBeUndefined();
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

it.effect("configures the current agent endpoint instead of a pre-reconnect snapshot", () =>
  Effect.gen(function* () {
    const original = host("b");
    const stale = yield* original.ensureAgentReady(() => Effect.void);
    const current = {
      ...stale,
      agentDevice: { ...stale.agentDevice, baseUrl: "http://reconnected", token: "new-token" },
    };
    const written: (typeof current.agentDevice)[] = [];
    const service = yield* makeWithHosts(
      new Map([
        [
          original.id,
          {
            ...original,
            withCurrentAgent: (use) => use(current),
          },
        ],
      ]),
      undefined,
      (_, ready) =>
        Effect.sync(() => {
          written.push(ready.agentDevice);
          return "/host-config.json";
        }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    yield* service.agentTarget({
      threadId: ThreadId.make("thread"),
      hostId: "b",
      deviceId: "device",
    });
    expect(written).toEqual([current.agentDevice]);
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

it.effect("rechecks revoked access after readiness before persisting agent configuration", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const original = host("b");
    const started = yield* Deferred.make<void>();
    let writes = 0;
    const service = yield* makeWithHosts(
      new Map([
        [
          original.id,
          {
            ...original,
            ensureAgentReady: (onPhase) =>
              original
                .ensureAgentReady(onPhase)
                .pipe(Effect.tap(() => Deferred.succeed(started, undefined))),
          },
        ],
      ]),
      undefined,
      () =>
        Effect.sync(() => {
          writes++;
          return "/host-config.json";
        }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    const targeting = yield* service.withLifecycleLock(
      Effect.gen(function* () {
        const fiber = yield* service
          .agentTarget({
            threadId: ThreadId.make("thread"),
            hostId: "b",
            deviceId: "device",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        // Let readiness finish while the final configuration write is blocked on this lock.
        yield* service.agentReadinessIfSupported("b");
        yield* settings.updateSettings({ enableAgentDeviceAccess: false });
        return fiber;
      }),
    );
    expect((yield* Fiber.join(targeting))._tag).toBe("Failure");
    expect(writes).toBe(0);
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);
