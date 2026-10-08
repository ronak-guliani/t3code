import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

const appBundleArgument = process.argv.slice(2).find((argument) => argument !== "--");
const appBundle = appBundleArgument ? resolve(appBundleArgument) : undefined;
if (!appBundle?.endsWith(".app")) {
  throw new Error("Usage: node scripts/bench-packaged-startup.mjs <path-to-app.app>");
}
if (process.platform !== "darwin") {
  throw new Error("The packaged app bundle benchmark currently supports macOS only.");
}

const executableDir = join(appBundle, "Contents", "MacOS");
const executableName = basename(appBundle, ".app");
const preferredExecutable = join(executableDir, executableName);
const executable = await stat(preferredExecutable)
  .then(() => preferredExecutable)
  .catch(async () => {
    const candidates = (await readdir(executableDir, { withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    );
    if (candidates.length !== 1 || !candidates[0]) {
      throw new Error(`Cannot identify the app executable under ${executableDir}.`);
    }
    return join(executableDir, candidates[0].name);
  });

const workDir = await mkdtemp(join(tmpdir(), "t3code-packaged-perf-"));
const homeDir = join(workDir, "home");
const baseDir = join(workDir, "t3-home");
const logDir = join(baseDir, "userdata", "logs");
const logFile = join(logDir, "desktop-main.log");
await Promise.all([
  mkdir(join(homeDir, "Library", "Application Support"), { recursive: true }),
  mkdir(logDir, { recursive: true }),
  mkdir(join(workDir, "tmp"), { recursive: true }),
]);

const getFreePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a local port.");
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
};
const sampleProcessTree = (rootPid) => {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const processes = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((values) => values.length === 4 && values.every(Number.isFinite))
    .map(([pid, parentPid, cpuPercent, rssKb]) => ({ pid, parentPid, cpuPercent, rssKb }));
  const processIds = new Set([rootPid]);
  let addedProcess = true;
  while (addedProcess) {
    addedProcess = false;
    for (const process of processes) {
      if (!processIds.has(process.pid) && processIds.has(process.parentPid)) {
        processIds.add(process.pid);
        addedProcess = true;
      }
    }
  }
  const members = processes.filter((process) => processIds.has(process.pid));
  if (members.length === 0) return null;
  return {
    processCount: members.length,
    cpuPercent: members.reduce((total, process) => total + process.cpuPercent, 0),
    rssKb: members.reduce((total, process) => total + process.rssKb, 0),
  };
};

const waitForExit = async (child, timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const exit = once(child, "exit").then(() => true);
  const exited = await Promise.race([exit, timeout]);
  clearTimeout(timer);
  return exited;
};

const runLaunch = async (label, port) => {
  const existingLog = await readFile(logFile, "utf8").catch(() => "");
  let offset = existingLog.length;
  let remaining = "";
  let appendedLog = "";
  let output = "";
  const timestamps = {};
  const startedAtWallMs = Date.now();
  const startedAtMonotonicMs = performance.now();
  const childEnv = {
    ...process.env,
    HOME: homeDir,
    TMPDIR: join(workDir, "tmp"),
    T3CODE_HOME: baseDir,
    T3CODE_PORT: String(port),
  };
  delete childEnv.VITE_DEV_SERVER_URL;
  const child = spawn(executable, [], {
    cwd: workDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  });

  const markerFor = (message) => {
    if (message === "app ready") return "appReady";
    if (message === "bootstrap start") return "bootstrapStarted";
    if (message === "bootstrap backend start requested") return "backendStartRequested";
    if (message.startsWith("bootstrap backend ready source=")) return "backendReady";
    if (message === "bootstrap loading window navigated to backend") return "rendererNavigated";
    return null;
  };
  const startupTimeoutMs = Number(process.env.T3CODE_BENCH_STARTUP_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + startupTimeoutMs;

  try {
    while (Date.now() < deadline && child.exitCode === null) {
      const currentLog = await readFile(logFile, "utf8").catch(() => "");
      if (currentLog.length > offset) {
        const added = currentLog.slice(offset);
        offset = currentLog.length;
        appendedLog += added;
        const lines = (remaining + added).split(/\r?\n/u);
        remaining = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = /^\[([^\]]+)\]\s+\[[^\]]+\]\s+(.*)$/u.exec(line);
          if (!parsed?.[1] || !parsed[2]) continue;
          const marker = markerFor(parsed[2]);
          if (marker && timestamps[marker] === undefined) {
            timestamps[marker] = Date.parse(parsed[1]);
          }
        }
      }
      if (timestamps.rendererNavigated !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const required = [
      "appReady",
      "bootstrapStarted",
      "backendStartRequested",
      "backendReady",
      "rendererNavigated",
    ];
    const missing = required.filter((key) => timestamps[key] === undefined);
    if (missing.length > 0) {
      const serverLog = await readFile(
        join(baseDir, "userdata", "logs", "server-child.log"),
        "utf8",
      ).catch(() => "");
      throw new Error(
        `${label} launch missed ${missing.join(", ")}. Child output:\n${output.slice(-4_000)}\nDesktop log:\n${appendedLog.slice(-8_000)}\nServer log:\n${serverLog.slice(-8_000)}`,
      );
    }

    const processTreeSample = typeof child.pid === "number" ? sampleProcessTree(child.pid) : null;
    const wallTimeToNavigationObservedMs = Number(
      (performance.now() - startedAtMonotonicMs).toFixed(2),
    );
    return {
      label,
      processToAppReadyMs: timestamps.appReady - startedAtWallMs,
      appReadyToBackendStartMs: timestamps.backendStartRequested - timestamps.appReady,
      backendStartToReadyMs: timestamps.backendReady - timestamps.backendStartRequested,
      backendReadyToRendererNavigationMs: timestamps.rendererNavigated - timestamps.backendReady,
      processToRendererNavigationMs: timestamps.rendererNavigated - startedAtWallMs,
      wallTimeToNavigationObservedMs,
      processTreeCpuPercentAtNavigation:
        processTreeSample === null ? null : Number(processTreeSample.cpuPercent.toFixed(1)),
      processTreeRssMiBAtNavigation:
        processTreeSample === null ? null : Number((processTreeSample.rssKb / 1024).toFixed(1)),
      processTreeCountAtNavigation: processTreeSample?.processCount ?? null,
      windowRevealMs: null,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (!(await waitForExit(child, 20_000))) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
    }
  }
};

const keepState = process.env.T3CODE_BENCH_KEEP_STATE === "1";
try {
  const port = await getFreePort();
  const cold = await runLaunch("cold", port);
  const warm = await runLaunch("warm", port);
  console.log(
    JSON.stringify({
      benchmark: "packaged-desktop-startup",
      appBundle,
      platform: process.platform,
      isolatedState: true,
      backendPort: port,
      measurements: [cold, warm],
      limitation:
        "ps CPU is time-averaged and RSS is sampled at renderer navigation; window reveal is unmeasured.",
    }),
  );
} finally {
  if (keepState) {
    console.warn(JSON.stringify({ benchmarkStateDirectory: workDir, desktopLog: logFile }));
  } else {
    await rm(workDir, { recursive: true, force: true });
  }
}
