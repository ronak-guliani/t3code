import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  make,
  renderLaunchAgent,
  renderSystemdUnit,
  SERVICE_LABEL,
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
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let loaded = false;
  let disabled = false;
  const host: ServiceHost = {
    exists: async (path) => files.has(path),
    read: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeAtomic: async (path, contents) => {
      files.set(path, contents);
    },
    copyRuntimeAtomic: async (_source, destination) => {
      files.set(`${destination}/bin.mjs`, "bundle");
    },
    remove: async (path) => {
      files.delete(path);
    },
    run: async (command, args) => {
      commands.push({ command, args });
      if (command === "/bin/launchctl" && args[0] === "print") return result(loaded ? 0 : 113);
      if (command === "/bin/launchctl" && args[0] === "print-disabled") {
        return result(0, disabled ? `"${SERVICE_LABEL}" => true\n` : "");
      }
      if (command === "/bin/launchctl" && args[0] === "bootstrap") loaded = true;
      if (command === "/bin/launchctl" && args[0] === "bootout") loaded = false;
      if (command === "/bin/launchctl" && args[0] === "disable") disabled = true;
      if (command === "/bin/launchctl" && args[0] === "enable") disabled = false;
      if (command === "systemctl" && args[1] === "is-active") return result(loaded ? 0 : 3);
      if (command === "systemctl" && args[1] === "is-enabled") return result(disabled ? 1 : 0);
      if (command === "systemctl" && ["restart", "start"].includes(args[1] ?? "")) loaded = true;
      if (command === "systemctl" && args.includes("disable")) {
        loaded = false;
        disabled = true;
      }
      if (command === "systemctl" && args.includes("enable")) disabled = false;
      if (command === "systemctl" && args[1] === "stop") loaded = false;
      return result();
    },
  };
  return { host, files, commands };
};

const plan: ServicePlan = {
  platform: "darwin",
  definitionPath: "/Users/me/Library/LaunchAgents/test.plist",
  logPath: "/Users/me/.t3/runtime/background-service/service.log",
  runtimePath: "/Users/me/.t3/runtime/background-service/dist/bin.mjs",
  arguments: ["/usr/bin/node", "/Users/me/.t3/runtime/background-service/dist/bin.mjs", "serve"],
  environment: {
    T3CODE_HOME: "/Users/me/.t3",
    T3CODE_SERVICE_CWD: "/Users/me/code",
  },
};

it("renders restartable launchd and systemd definitions without shell evaluation", () => {
  const plist = renderLaunchAgent(plan);
  assert.include(plist, `<string>${SERVICE_LABEL}</string>`);
  assert.include(plist, "<key>KeepAlive</key>\n  <true/>");
  assert.include(plist, "<string>/Users/me/.t3</string>");

  const unit = renderSystemdUnit({ ...plan, platform: "linux" });
  assert.include(unit, "KillMode=control-group");
  assert.include(unit, "Restart=always");
  assert.include(unit, 'Environment="T3CODE_HOME=/Users/me/.t3"');
});

it.effect("installs, repairs, reports actual launchd state, and uninstalls idempotently", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const service = yield* make({
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: "/Applications/T3/dist/bin.mjs",
      processEnvironment: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    });
    const invocation = {
      baseDir: "/Users/me/.t3",
      cwd: "/Users/me/code",
      host: "127.0.0.1",
      port: 13_773,
      environment: {},
    } as const;

    yield* service.install(invocation);
    const status = yield* service.status;
    assert.isTrue(status.installed);
    assert.isTrue(status.current);
    assert.isTrue(status.running);
    const definition = fake.files.get(status.definitionPath) ?? "";
    assert.include(definition, "<string>--host</string>");
    assert.include(definition, "<string>127.0.0.1</string>");
    assert.include(definition, "<string>13773</string>");

    yield* service.stop;
    assert.isFalse((yield* service.status).running);
    yield* service.start;
    assert.isTrue((yield* service.status).running);
    yield* service.restart;
    assert.isTrue((yield* service.status).running);
    yield* service.disable;
    assert.isFalse((yield* service.status).enabled);
    yield* service.enable;
    assert.isTrue((yield* service.status).enabled);
    assert.isTrue(yield* service.uninstall);
    assert.isFalse((yield* service.status).installed);
    assert.isFalse(yield* service.uninstall);
  }),
);

it.effect("installs systemd with linger and reports Windows as unsupported", () =>
  Effect.gen(function* () {
    const linux = makeHost();
    const service = yield* make({
      host: linux.host,
      platform: "linux",
      homeDir: "/home/me",
      userId: 1000,
      executablePath: "/usr/bin/node",
      cliEntryPath: "/opt/t3/dist/bin.mjs",
      processEnvironment: {},
    });
    yield* service.install({
      baseDir: "/home/me/.t3",
      cwd: "/home/me/code",
      environment: {},
    });
    assert.isTrue(
      linux.commands.some(
        ({ command, args }) => command === "loginctl" && args.join(" ") === "enable-linger",
      ),
    );
    assert.isTrue((yield* service.status).running);

    const windows = yield* make({
      host: makeHost().host,
      platform: "win32",
      homeDir: "C:\\Users\\me",
      userId: null,
      executablePath: "node.exe",
      cliEntryPath: "C:\\t3\\dist\\bin.mjs",
      processEnvironment: {},
    });
    assert.isFalse((yield* windows.status).supported);
    assert.equal(
      (yield* windows
        .install({
          baseDir: "C:\\Users\\me\\.t3",
          cwd: "C:\\code",
          environment: {},
        })
        .pipe(Effect.flip))._tag,
      "BootServiceUnsupportedError",
    );
  }),
);
