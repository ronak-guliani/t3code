import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSkillAgentId } from "@t3tools/contracts";

export interface AgentSkillRoot {
  readonly agentId: ServerSkillAgentId;
  readonly agentName: string;
  readonly path: string;
  readonly source: "primary" | "readable" | "shared";
}

interface AgentRootDefinition {
  readonly agentId: Exclude<ServerSkillAgentId, "shared">;
  readonly agentName: string;
  readonly primaryRelativePath: string;
  readonly additionalReadableAgentIds?: ReadonlyArray<Exclude<ServerSkillAgentId, "shared">>;
  readonly readsShared?: boolean;
}

const AGENT_ROOTS: ReadonlyArray<AgentRootDefinition> = [
  { agentId: "claude-code", agentName: "Claude Code", primaryRelativePath: ".claude/skills" },
  { agentId: "codex", agentName: "Codex", primaryRelativePath: ".codex/skills", readsShared: true },
  { agentId: "gemini-cli", agentName: "Gemini CLI", primaryRelativePath: ".gemini/skills" },
  {
    agentId: "copilot-cli",
    agentName: "Copilot CLI",
    primaryRelativePath: ".copilot/skills",
    additionalReadableAgentIds: ["claude-code"],
  },
  {
    agentId: "opencode",
    agentName: "OpenCode",
    primaryRelativePath: ".config/opencode/skills",
    additionalReadableAgentIds: ["claude-code"],
    readsShared: true,
  },
  {
    agentId: "antigravity",
    agentName: "Antigravity",
    primaryRelativePath: ".gemini/antigravity/skills",
  },
  {
    agentId: "cursor",
    agentName: "Cursor",
    primaryRelativePath: ".cursor/skills",
    additionalReadableAgentIds: ["claude-code"],
  },
  { agentId: "kiro", agentName: "Kiro", primaryRelativePath: ".kiro/skills" },
  { agentId: "codebuddy", agentName: "CodeBuddy", primaryRelativePath: ".codebuddy/skills" },
  { agentId: "openclaw", agentName: "OpenClaw", primaryRelativePath: ".openclaw/skills" },
  { agentId: "trae", agentName: "Trae", primaryRelativePath: ".trae/skills" },
  { agentId: "qoder", agentName: "Qoder", primaryRelativePath: ".qoder/skills" },
];

function homePath(homeDir: string, relativePath: string): string {
  return join(homeDir, relativePath);
}

export function listAgentSkillRoots(
  input: { readonly homeDir?: string } = {},
): ReadonlyArray<AgentSkillRoot> {
  const home = input.homeDir ?? homedir();
  const byAgentId = new Map(AGENT_ROOTS.map((root) => [root.agentId, root]));
  const roots: AgentSkillRoot[] = [
    {
      agentId: "shared",
      agentName: "Shared",
      path: homePath(home, ".agents/skills"),
      source: "shared",
    },
  ];

  for (const root of AGENT_ROOTS) {
    roots.push({
      agentId: root.agentId,
      agentName: root.agentName,
      path: homePath(home, root.primaryRelativePath),
      source: "primary",
    });
    for (const readableAgentId of root.additionalReadableAgentIds ?? []) {
      const readableRoot = byAgentId.get(readableAgentId);
      if (!readableRoot) {
        continue;
      }
      roots.push({
        agentId: root.agentId,
        agentName: root.agentName,
        path: homePath(home, readableRoot.primaryRelativePath),
        source: "readable",
      });
    }
    if (root.readsShared) {
      roots.push({
        agentId: root.agentId,
        agentName: root.agentName,
        path: homePath(home, ".agents/skills"),
        source: "readable",
      });
    }
  }

  return roots;
}
