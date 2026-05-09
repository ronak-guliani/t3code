import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { listServerSkills } from "./skillCatalog.ts";

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3-skills-"));
}

async function writeSkill(home: string, relativePath: string, content: string): Promise<string> {
  const skillDir = join(home, relativePath);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
  return skillDir;
}

describe("listServerSkills", () => {
  it("scans shared and agent-specific global skill directories", async () => {
    const home = await makeHome();
    await writeSkill(
      home,
      ".agents/skills/code-review",
      "---\nname: code-review\ndescription: Review code carefully.\n---\nBody",
    );
    await writeSkill(
      home,
      ".claude/skills/swiftui-pro",
      "---\nname: swiftui-pro\ndescription: SwiftUI guidance.\n---\nBody",
    );

    const result = await listServerSkills({ homeDir: home });

    expect(result.issues).toEqual([]);
    expect(result.skills.map((skill) => skill.id)).toEqual(["code-review", "swiftui-pro"]);
    expect(
      result.skills
        .find((skill) => skill.id === "code-review")
        ?.installations.map((i) => i.agentId),
    ).toEqual(["codex", "opencode", "shared"]);
  });

  it("merges symlinked installations into one skill", async () => {
    const home = await makeHome();
    const source = await writeSkill(
      home,
      ".agents/skills/shared-skill",
      "---\nname: shared-skill\ndescription: Shared skill.\n---\nBody",
    );
    await mkdir(join(home, ".codex/skills"), { recursive: true });
    await symlink(source, join(home, ".codex/skills/shared-skill"));

    const result = await listServerSkills({ homeDir: home });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.installations.map((i) => i.source).toSorted()).toEqual([
      "primary",
      "readable",
      "readable",
      "shared",
    ]);
  });

  it("reports malformed skill files without failing the catalog", async () => {
    const home = await makeHome();
    await writeSkill(home, ".claude/skills/no-frontmatter", "Plain markdown");

    const result = await listServerSkills({ homeDir: home });

    expect(result.skills[0]?.displayName).toBe("no-frontmatter");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "skill-malformed",
      message: "SKILL.md is missing YAML frontmatter.",
    });
    expect(result.issues[0]?.path.endsWith(join(".claude/skills/no-frontmatter/SKILL.md"))).toBe(
      true,
    );
  });

  it("parses folded block descriptions from skill frontmatter", async () => {
    const home = await makeHome();
    await writeSkill(
      home,
      ".agents/skills/folded-description",
      [
        "---",
        "name: folded-description",
        "description: >",
        "  First description line",
        "  continues on the next line.",
        "",
        "  Second paragraph.",
        "---",
        "Body",
      ].join("\n"),
    );

    const result = await listServerSkills({ homeDir: home });

    expect(result.issues).toEqual([]);
    expect(result.skills[0]?.description).toBe(
      "First description line continues on the next line.\n\nSecond paragraph.",
    );
    expect(result.skills[0]?.shortDescription).toBe(
      "First description line continues on the next line. Second paragraph.",
    );
  });
});
