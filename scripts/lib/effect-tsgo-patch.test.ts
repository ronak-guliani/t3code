import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { filesHaveEqualContents, removeNumberedEffectTsgoBackups } from "./effect-tsgo-patch.ts";

describe("effect-tsgo patch preparation", () => {
  it("detects when the installed binary is already patched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "effect-tsgo-patch-"));
    const installed = join(dir, "tsc");
    const packaged = join(dir, "packaged-tsc");

    await writeFile(installed, "patched");
    await writeFile(packaged, "patched");
    assert.isTrue(await filesHaveEqualContents(installed, packaged));

    await writeFile(installed, "original");
    assert.isFalse(await filesHaveEqualContents(installed, packaged));
  });

  it("removes only redundant numbered backups and preserves the canonical original", async () => {
    const dir = await mkdtemp(join(tmpdir(), "effect-tsgo-backups-"));
    const target = join(dir, "tsc");
    const canonicalBackup = `${target}.original`;
    const numberedBackups = [`${canonicalBackup}.1`, `${canonicalBackup}.100`];
    const unrelatedBackup = join(dir, "tsserver.original.1");

    await Promise.all([
      writeFile(target, "current"),
      writeFile(canonicalBackup, "original"),
      ...numberedBackups.map((path) => writeFile(path, "patched")),
      writeFile(unrelatedBackup, "unrelated"),
    ]);

    assert.deepStrictEqual(await removeNumberedEffectTsgoBackups(target), numberedBackups);
    assert.equal(await readFile(canonicalBackup, "utf8"), "original");
    assert.equal(await readFile(unrelatedBackup, "utf8"), "unrelated");
  });

  it("preserves numbered backups when the canonical original is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "effect-tsgo-backups-"));
    const target = join(dir, "tsc");
    const numberedBackup = `${target}.original.1`;

    await writeFile(numberedBackup, "only recovery copy");

    assert.deepStrictEqual(await removeNumberedEffectTsgoBackups(target), []);
    assert.equal(await readFile(numberedBackup, "utf8"), "only recovery copy");
  });
});
