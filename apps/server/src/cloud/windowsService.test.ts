import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { liveServiceHost, type ServiceHost } from "./bootService.ts";
import {
  makeWindowsService,
  powershellLiteral,
  renderWindowsLauncher,
  renderWindowsTask,
} from "./windowsService.ts";

const sid = "S-1-5-21-100-200-300-1001";
function fixture() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  let installed = false,
    enabled = false,
    running = false;
  let definition = "",
    foreground: number | undefined;
  let failCopy = false,
    failPreflight = false,
    failProbe = false;
  const host: ServiceHost = {
    ...liveServiceHost,
    canonicalize: async (path) => path,
    exists: async (path) => path.replaceAll("\\", "/").includes("/opt/t3/dist") || files.has(path),
    read: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing ${path}`);
      return value;
    },
    writeAtomic: async (path, contents) => {
      files.set(path, contents);
    },
    makeDirectory: async () => {},
    listDirectory: async () => [],
    copyRuntime: async (_from, to) => {
      if (failCopy) throw new Error("copy failed");
      files.set(join(to, "bin.mjs"), "copied");
    },
    remove: async (path) => {
      for (const key of files.keys())
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    },
    acquireLock: async () => ({ release: async () => {} }),
    activeRuntimePid: async (path) =>
      path.includes("userdata") && foreground !== undefined
        ? foreground
        : running
          ? 4321
          : undefined,
    probeRuntime: async () => {
      if (failProbe) {
        failProbe = false;
        throw new Error("health failed");
      }
      return true;
    },
    run: async (command, args) => {
      const script = args.at(-1) ?? "";
      commands.push(script);
      let stdout = "";
      if (command === "/node")
        return {
          code: failPreflight ? 1 : 0,
          stdout,
          stderr: "preflight failed",
          signal: null,
          timedOut: false,
        };
      if (script.includes("WindowsIdentity")) stdout = sid;
      else if (script.includes("ConvertTo-Json"))
        stdout = JSON.stringify({ installed, enabled, running });
      else if (script.endsWith("$task.Xml")) stdout = definition;
      else if (script.includes("$folder.RegisterTask")) {
        installed = true;
        enabled = true;
        definition =
          /RegisterTask\('[^']+', '([\s\S]*)', 6,/.exec(script)?.[1]?.replaceAll("''", "'") ?? "";
      } else if (script.includes("$task.Stop(0)")) running = false;
      else if (script.includes("$task.Run($null)")) running = true;
      else if (script.includes("$task.Enabled=$false")) enabled = false;
      else if (script.includes("$task.Enabled=$true")) enabled = true;
      else if (script.includes("$folder.DeleteTask")) {
        installed = false;
        running = false;
        enabled = false;
      }
      return { code: 0, stdout, stderr: "", signal: null, timedOut: false };
    },
  };
  return {
    files,
    commands,
    service: () =>
      makeWindowsService({
        host,
        baseDir: "/home/me/.t3",
        homeDir: "/home/me",
        executablePath: "/node",
        cliEntryPath: "/opt/t3/dist/bin.mjs",
        environment: { PATH: "/tools", SECRET_TOKEN: "do-not-copy" },
      }),
    foreground: (pid: number) => {
      foreground = pid;
    },
    failCopy: () => {
      failCopy = true;
    },
    failPreflight: () => {
      failPreflight = true;
    },
    failProbe: () => {
      failProbe = true;
    },
  };
}

describe("Windows managed hosting", () => {
  it("uses least-privilege interactive logon, bounded restart and no task time limit", () => {
    const task = renderWindowsTask({
      sid,
      description: "a&b",
      executable: "C:\\Program Files\\node.exe",
      launcher: "C:\\Users\\O'Brien\\run.mjs",
      cwd: "C:\\data",
    });
    expect(task).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(task).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(task).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(task).toContain("<Count>3</Count>");
    expect(task).toContain("a&amp;b");
    expect(task).not.toContain("<Password>");
    expect(powershellLiteral("x'; Stop-Process *; '")).toBe("'x''; Stop-Process *; '''");
  });
  it("installs, stops, resumes, disables, updates and uninstalls only the managed task", async () => {
    const fake = fixture(),
      service = await fake.service();
    const plan = await Effect.runPromise(service.install({ cwd: "/project", port: 13773 }));
    expect(await Effect.runPromise(service.status)).toMatchObject({
      supported: true,
      installed: true,
      responsive: true,
    });
    expect(plan.environment).not.toHaveProperty("SECRET_TOKEN");
    expect(renderWindowsLauncher(plan)).toContain("process.argv = ");
    await Effect.runPromise(service.stop);
    expect(await Effect.runPromise(service.status)).toMatchObject({ processAlive: false });
    await Effect.runPromise(service.start);
    await Effect.runPromise(service.disable);
    await expect(Effect.runPromise(service.start)).rejects.toThrow("enable");
    await Effect.runPromise(service.enable);
    await Effect.runPromise(service.install({ cwd: "/project", port: 13773 }));
    expect(await Effect.runPromise(service.uninstall)).toBe(true);
    expect(await Effect.runPromise(service.status)).toMatchObject({ installed: false });
    expect(fake.commands.some((command) => command.includes("Stop-Process"))).toBe(false);
  });
  it("refuses foreground takeover before copying or stopping", async () => {
    const fake = fixture(),
      service = await fake.service();
    fake.foreground(8000);
    await expect(Effect.runPromise(service.install({ cwd: "/project" }))).rejects.toThrow(
      "existing desktop or foreground",
    );
    expect(fake.files.size).toBe(0);
    expect(fake.commands.some((command) => command.includes("$task.Stop(0)"))).toBe(false);
  });
  for (const failure of ["failCopy", "failPreflight", "failProbe"] as const) {
    it(`preserves the previous host when ${failure} occurs`, async () => {
      const fake = fixture(),
        service = await fake.service();
      const plan = await Effect.runPromise(service.install({ cwd: "/project" }));
      const definition = fake.files.get(plan.definitionPath);
      fake[failure]();
      await expect(Effect.runPromise(service.install({ cwd: "/project" }))).rejects.toThrow();
      expect(fake.files.get(plan.definitionPath)).toBe(definition);
      expect(await Effect.runPromise(service.status)).toMatchObject({
        processAlive: true,
        responsive: true,
      });
    });
  }
});

it.skipIf(process.platform !== "win32")(
  "validates the real Windows Task Scheduler XML without registering a task",
  async () => {
    const task = renderWindowsTask({
      sid,
      description: "T3 XML schema smoke",
      executable: process.execPath,
      launcher: "C:\\Users\\example\\run.mjs",
      cwd: "C:\\Users\\example",
    });
    const result = await liveServiceHost.run(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.NewTask(0); $t.XmlText=${powershellLiteral(task)}; if ($t.Principal.LogonType -ne 3) {throw 'Wrong logon type'}; 'valid'`,
      ],
      15_000,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("valid");
  },
);

it.skipIf(process.platform !== "win32")(
  "runs the native per-user lifecycle with an isolated dependency-free host",
  async () => {
    const root = await mkdtemp(join(homedir(), "t3-service-native-"));
    const baseDir = join(root, "home"),
      dist = join(root, "package", "dist");
    await mkdir(join(dist, "client"), { recursive: true });
    await writeFile(join(dist, "client", "index.html"), "native fixture");
    await writeFile(
      join(dist, "bin.mjs"),
      `
    import { createServer } from 'node:http';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    if (!process.argv.includes('--help')) {
      const server = createServer((_, res) => res.end('ready'));
      server.listen(0, '127.0.0.1', async () => {
        const state = JSON.stringify({version:1, pid:process.pid, origin:'http://127.0.0.1:'+server.address().port, port:server.address().port, startedAt:new Date().toISOString(), owner:'background'});
        for (const path of [process.env.T3CODE_SERVICE_RUNTIME_STATE_PATH, join(process.env.T3CODE_HOME,'userdata','server-runtime.json')]) {
          await mkdir(dirname(path), {recursive:true}); await writeFile(path, state);
        }
      });
    }
  `,
    );
    const service = await makeWindowsService({
      host: { ...liveServiceHost, copyRuntime: (from, to) => cp(from, to, { recursive: true }) },
      baseDir,
      homeDir: homedir(),
      executablePath: process.execPath,
      cliEntryPath: join(dist, "bin.mjs"),
      environment: process.env,
    });
    let stopped = false;
    try {
      await Effect.runPromise(service.install({ cwd: root }));
      expect(await Effect.runPromise(service.status)).toMatchObject({
        responsive: true,
        enabled: true,
      });
      await Effect.runPromise(service.stop);
      expect(await Effect.runPromise(service.status)).toMatchObject({ processAlive: false });
      await Effect.runPromise(service.start);
      await Effect.runPromise(service.install({ cwd: root }));
      expect(await Effect.runPromise(service.status)).toMatchObject({ responsive: true });
      await Effect.runPromise(service.disable);
      expect(await Effect.runPromise(service.status)).toMatchObject({
        enabled: false,
        processAlive: false,
      });
      await Effect.runPromise(service.enable);
      expect(await Effect.runPromise(service.status)).toMatchObject({ responsive: true });
    } finally {
      try {
        await Effect.runPromise(service.uninstall);
        stopped = true;
      } finally {
        if (stopped) await rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
