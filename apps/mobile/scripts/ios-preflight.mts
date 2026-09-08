import { execFileSync } from "node:child_process";

export function assertSupportedXcode(output: string): void {
  const version = /^Xcode (\d+)\.(\d+)(?:\.\d+)?$/m.exec(output);
  if (!version) {
    throw new Error("Could not read the active Xcode version from `xcodebuild -version`.");
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  if (major < 26 || (major === 26 && minor < 4)) {
    throw new Error(
      `Expo SDK 57 requires Xcode 26.4 or newer; active version is ${version[0]}. ` +
        "Select a compatible Xcode with DEVELOPER_DIR or use the EAS simulator profiles. " +
        "Native generation and signing were not started.",
    );
  }
}

if (import.meta.main) {
  assertSupportedXcode(execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }));
}
