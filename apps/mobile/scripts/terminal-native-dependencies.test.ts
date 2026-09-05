import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("resolves the vendored headers required by the Android terminal bridge", () => {
  const sourceDirectory = fileURLToPath(
    new URL("../modules/t3-terminal/android/src/main/cpp/", import.meta.url),
  );
  const cmake = readFileSync(resolve(sourceDirectory, "CMakeLists.txt"), "utf8");
  const relativeInclude = cmake.match(/PRIVATE "\$\{CMAKE_CURRENT_SOURCE_DIR\}\/([^"]+)"/)?.[1];
  assert.ok(relativeInclude, "The terminal target must declare its native header directory.");
  const includeDirectory = resolve(sourceDirectory, relativeInclude);
  const bridge = readFileSync(resolve(sourceDirectory, "t3_terminal_jni.cpp"), "utf8");
  const headers = [...bridge.matchAll(/^#include <(ghostty\/[^>]+)>/gm)].map((match) => match[1]);
  expect(headers.length).toBeGreaterThan(0);
  for (const header of headers) {
    assert.ok(header);
    expect(readFileSync(resolve(includeDirectory, header), "utf8").length).toBeGreaterThan(0);
  }
});
