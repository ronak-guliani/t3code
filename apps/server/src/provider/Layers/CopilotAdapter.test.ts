import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { COPILOT_AGENT_MODE_ID, COPILOT_PLAN_MODE_ID } from "../acp/CopilotAcpSupport.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

const isolateCopilotHome = Effect.fn("isolateCopilotHome")(function* () {
  const previousHome = process.env.HOME;
  const temporaryHome = yield* Effect.promise(() =>
    mkdtemp(path.join(os.tmpdir(), "copilot-adapter-home-")),
  );
  process.env.HOME = temporaryHome;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }),
  );
  return temporaryHome;
});

async function makeMockCopilotWrapper(
  extraEnv?: Record<string, string>,
  options?: { argvLogPath?: string },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copilot-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-copilot.sh");
  const envExports = Object.entries({
    T3_ACP_AUTH_METHODS: "copilot-login",
    ...extraEnv,
  })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const argvLog = options?.argvLogPath
    ? `printf '%s\\t' "$@" >> ${JSON.stringify(options.argvLogPath)}
printf '\\n' >> ${JSON.stringify(options.argvLogPath)}`
    : "";
  const script = `#!/bin/sh
${argvLog}
${envExports}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

const copilotAdapterTestLayer = it.layer(
  makeCopilotAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-copilot-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

copilotAdapterTestLayer("CopilotAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-mock-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper());
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: "copilot",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "copilot", model: "auto" },
      });

      assert.equal(session.provider, "copilot");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((event) => event.type);

      for (const type of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, type);
      }

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.provider, "copilot");
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts Copilot with ACP stdio args and switches modes via session/set_mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-mode-thread");

      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-mode-")),
      );
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper(
          {
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
          { argvLogPath },
        ),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "copilot",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "copilot", model: "auto" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this",
        attachments: [],
        interactionMode: "plan",
      });

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepEqual(argv[0], ["--acp", "--stdio"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.include(methods, "initialize");
      assert.include(methods, "authenticate");
      assert.include(methods, "session/new");
      assert.include(methods, "session/set_mode");
      assert.include(methods, "session/prompt");

      const setModePayloads = requests
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params as { readonly modeId?: string });
      assert.deepEqual(
        setModePayloads.map((payload) => payload.modeId),
        [COPILOT_AGENT_MODE_ID, COPILOT_PLAN_MODE_ID],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies configured and selected Copilot models through ACP session config", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-model-thread");

      yield* isolateCopilotHome();

      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "copilot-adapter-model-")),
      );
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const projectDir = path.join(tempDir, "project");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });
      yield* Effect.promise(() => mkdir(path.join(projectDir, ".copilot"), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          path.join(projectDir, ".copilot", "config.json"),
          JSON.stringify({ model: "composer-2" }),
          "utf8",
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: "copilot",
        cwd: projectDir,
        runtimeMode: "full-access",
        modelSelection: { provider: "copilot", model: "auto" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use configured model",
        attachments: [],
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.3-codex[reasoning=medium,fast=false]",
        },
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const setConfigPayloads = requests
        .filter((request) => request.method === "session/set_config_option")
        .map(
          (request) => request.params as { readonly configId?: string; readonly value?: string },
        );

      assert.deepEqual(
        setConfigPayloads
          .filter((payload) => payload.configId === "model")
          .map((payload) => payload.value),
        ["composer-2", "gpt-5.3-codex[reasoning=medium,fast=false]"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes ACP form elicitation through user-input lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("copilot-elicitation-thread");

      yield* isolateCopilotHome();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
        }),
      );
      yield* settings.updateSettings({ providers: { copilot: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId,
        provider: "copilot",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { provider: "copilot", model: "auto" },
      });

      const requestedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.resolved"),
        Stream.runHead,
        Effect.forkChild,
      );
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "deploy",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Fiber.join(requestedEventFiber);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      assert.equal(requestedEvent.value.threadId, session.threadId);
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "environment");
      assert.equal(requestedEvent.value.payload.questions[1]?.id, "runChecks");
      assert.deepEqual(
        requestedEvent.value.payload.questions[0]?.options.map((option) => option.label),
        ["staging", "production"],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(requestedEvent.value.requestId!),
        {
          environment: "staging",
          runChecks: "true",
        },
      );

      const resolvedEvent = yield* Fiber.join(resolvedEventFiber);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        environment: "staging",
        runChecks: "true",
      });

      const turn = yield* Fiber.join(sendFiber);
      assert.equal(turn.threadId, threadId);
      yield* adapter.stopSession(threadId);
    }),
  );
});
