import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type CommandEntry = ServerProviderSlashCommand & {
  readonly path: string;
};

const AGENTS_DIR = ".agents";
const SKILL_FILE_NAME = "SKILL.md";
const FLAT_AGENT_SUFFIX = ".agent.md";

function trimYamlScalar(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function extractFrontmatter(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex < 2) {
    return null;
  }
  return lines.slice(1, endIndex).join("\n");
}

function parseSkillMetadata(content: string): { name?: string; description?: string } | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  let name: string | undefined;
  let description: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      const value = trimYamlScalar(trimmed.slice("name:".length));
      if (value.length > 0) {
        name = value;
      }
      continue;
    }
    if (trimmed.startsWith("description:")) {
      const value = trimYamlScalar(trimmed.slice("description:".length));
      if (value.length > 0) {
        description = value;
      }
    }
  }

  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

async function readSortedDirectoryEntries(root: string) {
  try {
    return (await readdir(root, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

async function loadNestedCommandsFromRoot(root: string): Promise<CommandEntry[]> {
  const entries = await readSortedDirectoryEntries(root);
  const commands: CommandEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const skillPath = join(root, entry.name, SKILL_FILE_NAME);
    let content: string;
    try {
      content = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }

    const metadata = parseSkillMetadata(content);
    if (!metadata?.name || !metadata.description) {
      continue;
    }

    commands.push({
      name: metadata.name,
      description: metadata.description,
      path: skillPath,
    });
  }

  return commands;
}

function flatAgentNameFromPath(path: string): string | null {
  const fileName = basename(path);
  if (!fileName.endsWith(FLAT_AGENT_SUFFIX)) {
    return null;
  }
  const commandName = fileName.slice(0, -FLAT_AGENT_SUFFIX.length);
  return commandName.length > 0 ? commandName : null;
}

async function loadFlatAgentCommandsFromRoot(root: string): Promise<CommandEntry[]> {
  const entries = await readSortedDirectoryEntries(root);
  const commands: CommandEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(FLAT_AGENT_SUFFIX)) {
      continue;
    }
    const agentPath = join(root, entry.name);
    const commandName = flatAgentNameFromPath(agentPath);
    if (!commandName) {
      continue;
    }

    let content: string;
    try {
      content = await readFile(agentPath, "utf8");
    } catch {
      continue;
    }

    const description = parseSkillMetadata(content)?.description;
    if (!description) {
      continue;
    }

    commands.push({
      name: commandName,
      description,
      path: agentPath,
    });
  }

  return commands;
}

export function dedupeCopilotPreconnectionCommands(
  commands: Iterable<ServerProviderSlashCommand>,
): ServerProviderSlashCommand[] {
  const seen = new Set<string>();
  const deduped: ServerProviderSlashCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    deduped.push(command);
  }
  return deduped;
}

export async function listCopilotPreconnectionCommands(input: {
  readonly cwd: string;
  readonly homeDir?: string | null;
}): Promise<ServerProviderSlashCommand[]> {
  const roots = [
    join(input.cwd, AGENTS_DIR),
    ...(input.homeDir === null ? [] : [join(input.homeDir ?? homedir(), AGENTS_DIR)]),
  ];
  const skillRoots = roots.map((root) => join(root, "skills"));

  const nestedSkillCommands = (
    await Promise.all(skillRoots.map((root) => loadNestedCommandsFromRoot(root)))
  ).flat();
  const nestedAgentCommands = (
    await Promise.all(roots.map((root) => loadNestedCommandsFromRoot(root)))
  ).flat();
  const flatAgentCommands = (
    await Promise.all(roots.map((root) => loadFlatAgentCommandsFromRoot(root)))
  ).flat();

  const deduped = dedupeCopilotPreconnectionCommands([
    ...nestedSkillCommands,
    ...nestedAgentCommands,
    ...flatAgentCommands,
  ]);
  const commands: ServerProviderSlashCommand[] = [];
  for (const { name, description, input } of deduped) {
    commands.push(
      Object.assign(
        { name },
        description ? { description } : {},
        input ? { input } : {},
      ) satisfies ServerProviderSlashCommand,
    );
  }
  return commands;
}
