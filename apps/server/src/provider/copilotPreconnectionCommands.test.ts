import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { listCopilotPreconnectionCommands } from "./copilotPreconnectionCommands.ts";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "t3-copilot-agents-"));
  tempDirs.push(dir);
  return dir;
}

function skillFileContent(name: string, description: string): string {
  return `---
name: "${name}"
description: "${description}"
---

# ${name}
`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("listCopilotPreconnectionCommands", () => {
  it("loads project and home .agents skill commands in precedence order", async () => {
    const root = await makeTempDir();
    const project = join(root, "project");
    const home = join(root, "home");

    await mkdir(join(project, ".agents", "skills", "systematic-debugging"), { recursive: true });
    await mkdir(join(home, ".agents", "skills", "ce-review"), { recursive: true });
    await writeFile(
      join(project, ".agents", "skills", "systematic-debugging", "SKILL.md"),
      skillFileContent("systematic-debugging", "Project-specific systematic debugging flow"),
    );
    await writeFile(
      join(home, ".agents", "skills", "ce-review", "SKILL.md"),
      skillFileContent("ce-review", "Review code changes"),
    );

    await expect(
      listCopilotPreconnectionCommands({ cwd: project, homeDir: home }),
    ).resolves.toEqual([
      {
        name: "systematic-debugging",
        description: "Project-specific systematic debugging flow",
      },
      { name: "ce-review", description: "Review code changes" },
    ]);
  });

  it("loads nested agent directories and flat markdown agents", async () => {
    const root = await makeTempDir();
    const project = join(root, "project");

    await mkdir(join(project, ".agents", "security-reviewer"), { recursive: true });
    await writeFile(
      join(project, ".agents", "security-reviewer", "SKILL.md"),
      skillFileContent("security-reviewer", "Review security-sensitive changes"),
    );
    await writeFile(
      join(project, ".agents", "release-notes.agent.md"),
      `---
description: "Draft release notes"
---

# Release notes
`,
    );
    await writeFile(join(project, ".agents", "README.md"), "# ignored");

    await expect(
      listCopilotPreconnectionCommands({ cwd: project, homeDir: null }),
    ).resolves.toEqual([
      { name: "security-reviewer", description: "Review security-sensitive changes" },
      { name: "release-notes", description: "Draft release notes" },
    ]);
  });

  it("deduplicates commands while keeping the first provider-owned source", async () => {
    const root = await makeTempDir();
    const project = join(root, "project");
    const home = join(root, "home");

    await mkdir(join(project, ".agents", "skills", "review"), { recursive: true });
    await mkdir(join(home, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(project, ".agents", "skills", "review", "SKILL.md"),
      skillFileContent("review", "Project review"),
    );
    await writeFile(
      join(home, ".agents", "skills", "review", "SKILL.md"),
      skillFileContent("review", "Home review"),
    );

    await expect(
      listCopilotPreconnectionCommands({ cwd: project, homeDir: home }),
    ).resolves.toEqual([{ name: "review", description: "Project review" }]);
  });
});
