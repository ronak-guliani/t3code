import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";

const nativeIt = process.platform === "darwin" ? it : it.skip;

describe("ReviewDiffRowValueStore", () => {
  nativeIt("invalidates only rows whose token values changed", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "t3-review-diff-token-store-"));
    const executablePath = join(temporaryDirectory, "ReviewDiffRowValueStoreTests");
    const testPath = join(temporaryDirectory, "main.swift");
    const storePath = resolve(
      import.meta.dirname,
      "../../../modules/t3-review-diff/ios/ReviewDiffRowValueStore.swift",
    );

    writeFileSync(
      testPath,
      `
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    fatalError(message)
  }
}

var store = ReviewDiffRowValueStore<[String]>()
store.replace(with: [
  "existing": ["old"],
  "unchanged": ["same"],
])

let changedRows = store.merge([
  "existing": ["new"],
  "unchanged": ["same"],
  "missing": ["added"],
])

expect(changedRows == Set(["existing", "missing"]), "merge invalidated unchanged rows")
expect(store.valuesByRowId["existing"] == ["new"], "changed row was not replaced")
expect(store.valuesByRowId["unchanged"] == ["same"], "unchanged row was modified")
expect(store.valuesByRowId["missing"] == ["added"], "missing row was not added")
expect(store.merge(["existing": ["new"]]).isEmpty, "identical patch invalidated a row")

store.replace(with: [:])
expect(store.valuesByRowId.isEmpty, "full replacement did not clear token storage")
`,
    );

    try {
      execFileSync("swiftc", [storePath, testPath, "-o", executablePath], { stdio: "pipe" });
      execFileSync(executablePath, [], { stdio: "pipe" });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
