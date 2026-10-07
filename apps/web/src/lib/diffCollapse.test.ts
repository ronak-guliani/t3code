import { describe, expect, it } from "vitest";

import {
  areAllDiffFilesCollapsed,
  mergeCollapsedFileKeys,
  toggleAllDiffFiles,
} from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;
const LARGE_FILE_KEY = "src/generated.ts";

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("folds large diffs by default and leaves normal diffs open", () => {
    expect(mergeCollapsedFileKeys(new Set([LARGE_FILE_KEY]), new Map())).toEqual(
      new Set([LARGE_FILE_KEY]),
    );
  });

  it("lets an explicit expansion override the large-diff default", () => {
    const merged = mergeCollapsedFileKeys(
      new Set([LARGE_FILE_KEY]),
      new Map([[LARGE_FILE_KEY, false]]),
    );
    expect(merged.size).toBe(0);
  });

  it("lets an explicit collapse override an open default", () => {
    const merged = mergeCollapsedFileKeys(new Set(), new Map([[FIRST_FILE_KEY, true]]));
    expect(merged).toEqual(new Set([FIRST_FILE_KEY]));
  });

  it("records collapse for every rendered file", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, true)).toEqual(
      new Map([
        [FIRST_FILE_KEY, true],
        [FILE_KEYS[1]!, true],
      ]),
    );
  });

  it("records expansion for every rendered file, overriding large-diff defaults", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, false)).toEqual(
      new Map([
        [FIRST_FILE_KEY, false],
        [FILE_KEYS[1]!, false],
      ]),
    );
  });
});
