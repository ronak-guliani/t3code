import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  launchLocalDevRebuild,
  readEmbeddedDevSourceRoot,
  resolveLocalDevRebuildState,
} from "./localDevRebuild.ts";

function makeCheckout(): string {
  const sourceRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-"));
  FS.mkdirSync(Path.join(sourceRoot, "scripts"));
  FS.writeFileSync(
    Path.join(sourceRoot, "package.json"),
    JSON.stringify({ name: "@t3tools/monorepo" }),
  );
  FS.writeFileSync(Path.join(sourceRoot, "scripts", "install-t3-dev.sh"), "#!/bin/bash\n");
  return sourceRoot;
}

describe("local Dev rebuild", () => {
  it("reads the source root embedded in packaged metadata", () => {
    const appRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-app-"));
    FS.writeFileSync(
      Path.join(appRoot, "package.json"),
      JSON.stringify({ t3codeDevSourceRoot: "/tmp/t3code" }),
    );

    expect(readEmbeddedDevSourceRoot(appRoot)).toBe("/tmp/t3code");
  });

  it("enables rebuilds only for a valid packaged macOS Dev checkout", () => {
    const sourceRoot = makeCheckout();

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot,
      }),
    ).toEqual({ enabled: true, sourceRoot: FS.realpathSync(sourceRoot), reason: null });

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: false,
        platform: "darwin",
        sourceRoot,
      }).enabled,
    ).toBe(false);
  });

  it("launches the fixed installer as a detached process", () => {
    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    const result = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      spawn as unknown as typeof import("node:child_process").spawn,
    );

    expect(result.accepted).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/bash",
      [Path.join(sourceRoot, "scripts", "install-t3-dev.sh")],
      expect.objectContaining({ cwd: sourceRoot, detached: true }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("rejects a missing checkout and reports synchronous launch failures", () => {
    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot: "/missing/t3code-checkout",
      }).enabled,
    ).toBe(false);

    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const result = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      vi.fn(() => {
        throw new Error("spawn failed");
      }) as unknown as typeof import("node:child_process").spawn,
    );

    expect(result).toEqual({
      accepted: false,
      logPath: Path.join(logDirectory, "dev-rebuild.log"),
      message: "spawn failed",
    });
  });
});
