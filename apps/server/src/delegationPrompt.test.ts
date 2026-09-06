import { describe, expect, it } from "vitest";

import { composeDelegationPrompt, parseDelegationPromptTemplate } from "./delegationPrompt.ts";

describe("delegationPrompt", () => {
  it("composes selected blocks in a stable order without unrelated boilerplate", () => {
    const prompt = composeDelegationPrompt("Trace the flaky test.", {
      blocks: ["reporting", "repository", "investigation-only"],
      repository: {
        context: "Repository: acme/widgets. Focus on src/cache.",
        instructionFiles: ["AGENTS.md", "scars.md"],
      },
    });

    expect(prompt).toBe(`## Task
Trace the flaky test.

## Repository instructions and context
Read and follow all applicable repository instruction files before acting. Treat repository-local guidance as authoritative for the files in its scope.

Instruction files to read:
- AGENTS.md
- scars.md

Repository context:
Repository: acme/widgets. Focus on src/cache.

## Permissions
Investigation only. Do not modify files, create commits, push branches, create or update pull requests, or perform destructive actions. Return evidence-based findings and recommendations.

## Expected report
Report the outcome, material findings or changes, validation results, commit SHA and pull request URL when applicable, blockers, and limitations. Do not claim actions that were not completed.`);
    expect(prompt).not.toContain("## Validation");
    expect(prompt).not.toContain("## Commit requirements");
  });

  it("supports per-block overrides and additions while retaining parameterized content", () => {
    const prompt = composeDelegationPrompt("Implement the parser.", {
      blocks: ["implementation", "validation", "commit", "push-and-create-pr", "reporting"],
      validation: { commands: ["pnpm test parser", "pnpm typecheck"] },
      commit: { requirements: ["Include the required co-author trailer."] },
      reporting: { items: ["Summarize the API design.", "Include the PR URL."] },
      overrides: {
        implementation: "You may edit source and test files needed for this task.",
        validation: "Run the targeted checks first, then all listed checks.",
      },
      additions: {
        "push-and-create-pr": ["Use the current branch and create a non-draft PR."],
      },
    });

    expect(prompt).toContain("You may edit source and test files needed for this task.");
    expect(prompt).not.toContain("Implementation is permitted.");
    expect(prompt).toContain("Run the targeted checks first, then all listed checks.");
    expect(prompt).toContain("- `pnpm test parser`\n- `pnpm typecheck`");
    expect(prompt).toContain("- Include the required co-author trailer.");
    expect(prompt).toContain("- Use the current branch and create a non-draft PR.");
    expect(prompt).toContain("- Summarize the API design.\n- Include the PR URL.");
  });

  it.each([
    {
      input: { blocks: ["investigation-only", "implementation"] },
      message: "cannot combine investigation-only and implementation",
    },
    {
      input: { blocks: ["investigation-only", "commit"] },
      message: "investigation-only permissions cannot include commit",
    },
    {
      input: { blocks: ["validation"] },
      message: "validation is required",
    },
    {
      input: {
        blocks: ["validation"],
        validation: { commands: ["pnpm test\nrm -rf ."] },
      },
      message: "must be a single-line command",
    },
    {
      input: {
        blocks: ["reporting"],
        overrides: { commit: "Create a commit." },
      },
      message: "requires selecting that block",
    },
    {
      input: { blocks: ["reporting"], unexpected: true },
      message: "unsupported field",
    },
  ])("rejects invalid or ambiguous composition: $message", ({ input, message }) => {
    expect(() => parseDelegationPromptTemplate(input)).toThrow(message);
  });
});
