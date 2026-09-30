import { spawnSync } from "node:child_process";

import {
  filesHaveEqualContents,
  removeNumberedEffectTsgoBackups,
  resolveEffectTsgoCli,
  resolveInstalledTypeScriptBinary,
} from "./lib/effect-tsgo-patch.ts";

function runEffectTsgo(cliPath: string, args: string[], captureOutput = false) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: captureOutput ? "pipe" : "inherit",
  });
}

async function main() {
  const cliPath = resolveEffectTsgoCli();
  const targetPath = resolveInstalledTypeScriptBinary();
  const removedBackups = await removeNumberedEffectTsgoBackups(targetPath);
  if (removedBackups.length > 0) {
    console.log(`Removed ${removedBackups.length} redundant Effect tsgo backup(s).`);
  }

  const packagedBinaryResult = runEffectTsgo(cliPath, ["get-exe-path"], true);
  if (packagedBinaryResult.error) throw packagedBinaryResult.error;
  if (packagedBinaryResult.status !== 0) {
    process.stdout.write(packagedBinaryResult.stdout ?? "");
    process.stderr.write(packagedBinaryResult.stderr ?? "");
    throw new Error(`effect-tsgo get-exe-path exited with code ${packagedBinaryResult.status}`);
  }

  const packagedBinaryPath = packagedBinaryResult.stdout.trim().split(/\r?\n/).at(-1);
  if (!packagedBinaryPath) {
    throw new Error("effect-tsgo get-exe-path returned no binary path");
  }

  if (await filesHaveEqualContents(targetPath, packagedBinaryPath)) {
    console.log("Effect Language Service binary is already patched.");
    return;
  }

  const patchResult = runEffectTsgo(cliPath, ["patch"]);
  if (patchResult.error) throw patchResult.error;
  if (patchResult.status !== 0) {
    throw new Error(`effect-tsgo patch exited with code ${patchResult.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
