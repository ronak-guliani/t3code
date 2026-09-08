import { spawn, execFileSync } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

execFileSync(process.execPath, ["scripts/build-browser-secret.mjs"], {
  cwd: desktopDir,
  stdio: "inherit",
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), ["dist-electron/main.cjs"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
