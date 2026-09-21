import { describe, expect, it } from "vitest";

import { selectFocusedTestFiles, ValidationPolicy } from "./ValidationPolicy.ts";

const ids = (paths: readonly string[], scope: "changed-behavior" | "full") =>
  new ValidationPolicy()
    .classify({ changedPaths: paths, scope })
    .requirements.map((requirement) => requirement.id);

describe("ValidationPolicy", () => {
  it("plans server, web, and contract changes without depending on path order", () => {
    const first = new ValidationPolicy().classify({
      changedPaths: [
        "packages/contracts/src/foo.ts",
        "apps/web/src/App.tsx",
        "apps/server/src/x.ts",
      ],
      scope: "changed-behavior",
    });
    const second = new ValidationPolicy().classify({
      changedPaths: [
        "apps/server/src/x.ts",
        "apps/web/src/App.tsx",
        "packages/contracts/src/foo.ts",
      ],
      scope: "changed-behavior",
    });

    expect(first).toEqual(second);
    expect(first.areas).toEqual(["server", "web", "contracts"]);
    expect(first.requirements.map((requirement) => requirement.id)).toEqual([
      "focused-tests",
      "format",
      "lint",
      "typecheck",
      "browser-validation",
    ]);
  });

  it("selects self-test for pairing, reconnect, auth, bootstrap, preview, and environment paths", () => {
    expect(
      ids(
        [
          "apps/web/src/preview/Panel.tsx",
          "apps/server/src/auth/bootstrap.ts",
          "apps/mobile/src/features/connection/pairing.ts",
          "scripts/self-test.ts",
          "apps/server/src/environment/ServerEnvironment.ts",
        ],
        "changed-behavior",
      ),
    ).toEqual([
      "focused-tests",
      "format",
      "lint",
      "typecheck",
      "pairing-self-test",
      "browser-validation",
    ]);
  });

  it("classifies each setup-sensitive path as a self-test requirement", () => {
    for (const changedPath of [
      "apps/server/src/auth/session.ts",
      "apps/server/src/bootstrap/start.ts",
      "apps/server/src/environment/ServerEnvironment.ts",
      "apps/server/src/preview/PreviewAutomation.ts",
      "apps/mobile/src/features/connection/reconnect.ts",
    ]) {
      expect(ids([changedPath], "changed-behavior")).toContain("pairing-self-test");
    }
  });

  it("uses full tests instead of focused tests for full scope", () => {
    expect(ids(["apps/server/src/server.ts"], "full")).toEqual([
      "full-tests",
      "format",
      "lint",
      "typecheck",
    ]);
  });

  it("leaves docs-only changes without executable requirements", () => {
    expect(ids(["docs/validation.md", ".docs/architecture.md", "CHANGELOG.md"], "full")).toEqual(
      [],
    );
  });

  it("deduplicates normalized paths and keeps mixed changes deterministic", () => {
    const plan = new ValidationPolicy().classify({
      changedPaths: ["./README.md", "apps/web\\src\\App.tsx", "apps/web/src/App.tsx"],
      scope: "changed-behavior",
    });
    expect(plan.changedPaths).toEqual(["README.md", "apps/web/src/App.tsx"]);
    expect(plan.requirements.map((requirement) => requirement.id)).toEqual([
      "focused-tests",
      "format",
      "lint",
      "typecheck",
      "browser-validation",
    ]);
  });

  it("selects only safe relative test files for focused runs", () => {
    expect(
      selectFocusedTestFiles([
        "apps/server/src/validation/policy.test.ts",
        "apps/server/src/server.ts",
        "README.md",
        "apps/server/src/validation/policy.test.ts",
      ]),
    ).toEqual(["apps/server/src/validation/policy.test.ts"]);
    expect(
      selectFocusedTestFiles([
        "/absolute/path.test.ts",
        "../escape.test.ts",
        "C:/win.test.ts",
        "apps/a.test.ts;rm",
      ]),
    ).toEqual([]);
    expect(selectFocusedTestFiles([])).toEqual([]);
  });
});
