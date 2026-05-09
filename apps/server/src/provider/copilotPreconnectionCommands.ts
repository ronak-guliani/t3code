import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseSkillFrontmatter } from "../skills/skillFrontmatter.ts";

type CommandEntry = ServerProviderSlashCommand & {
  readonly path: string;
};

const AGENTS_DIR = ".agents";
const SKILL_FILE_NAME = "SKILL.md";
const FLAT_AGENT_SUFFIX = ".agent.md";

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

    const metadata = parseSkillFrontmatter(content);
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

    const description = parseSkillFrontmatter(content)?.description;
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
