import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const COPILOT_MISSING_TRANSCRIPT_MARKER = "__missing_transcript__";

export interface CopilotHistoryWorkspace {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workspacePath: string | null;
  readonly eventsPath: string;
  readonly eventCount: number;
}

export interface ListCopilotHistoryInput {
  readonly homeDir?: string;
  readonly rootPath?: string;
}

function parseWorkspacePath(workspaceYaml: string): string | null {
  for (const line of workspaceYaml.split(/\r?\n/)) {
    const match = /^\s*(?:workspace|workspacePath|cwd|root):\s*["']?(.+?)["']?\s*$/.exec(line);
    if (match?.[1]) {
      return match[1].trim() || null;
    }
  }
  return null;
}

function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

async function countJsonLines(filePath: string): Promise<number> {
  const contents = await readFile(filePath, "utf8");
  return contents.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export async function listCopilotHistoryWorkspaces(
  input: ListCopilotHistoryInput = {},
): Promise<ReadonlyArray<CopilotHistoryWorkspace>> {
  const sessionStateDir = join(input.homeDir ?? homedir(), ".copilot", "session-state");
  const rootPath = input.rootPath ? resolve(input.rootPath) : null;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(sessionStateDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const workspaces: CopilotHistoryWorkspace[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const sessionDir = join(sessionStateDir, entry.name);
    const workspacePath = join(sessionDir, "workspace.yaml");
    const eventsPath = join(sessionDir, "events.jsonl");
    try {
      const workspaceYaml = await readFile(workspacePath, "utf8");
      const parsedWorkspacePath = parseWorkspacePath(workspaceYaml);
      if (parsedWorkspacePath && rootPath && !isWithinRoot(parsedWorkspacePath, rootPath)) {
        continue;
      }
      if (rootPath && !parsedWorkspacePath && !isWithinRoot(dirname(sessionDir), rootPath)) {
        continue;
      }
      const eventsStats = await stat(eventsPath).catch(() => null);
      workspaces.push({
        sessionId: entry.name,
        sessionDir,
        workspacePath: parsedWorkspacePath,
        eventsPath:
          eventsStats?.isFile() === true
            ? eventsPath
            : join(sessionDir, COPILOT_MISSING_TRANSCRIPT_MARKER),
        eventCount: eventsStats?.isFile() === true ? await countJsonLines(eventsPath) : 0,
      });
    } catch {
      continue;
    }
  }
  return workspaces;
}
