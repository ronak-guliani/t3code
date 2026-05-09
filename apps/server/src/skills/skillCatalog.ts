import type {
  ServerSkillCatalogEntry,
  ServerSkillCatalogIssue,
  ServerSkillInstallation,
} from "@t3tools/contracts";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { listAgentSkillRoots, type AgentSkillRoot } from "./agentSkillRoots.ts";
import { extractSkillPrompt, parseSkillFrontmatter } from "./skillFrontmatter.ts";

const SKILL_FILE_NAME = "SKILL.md";

interface MutableCatalogEntry {
  readonly id: string;
  name: string;
  displayName: string;
  description?: string;
  shortDescription?: string;
  prompt?: string;
  canonicalPath: string;
  readonly paths: Set<string>;
  readonly installations: Map<string, ServerSkillInstallation>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isMissingDirectoryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function issue(
  kind: ServerSkillCatalogIssue["kind"],
  path: string,
  message: string,
): ServerSkillCatalogIssue {
  return { kind, path, message };
}

function shortDescriptionFromDescription(description: string | undefined): string | undefined {
  if (!description) {
    return undefined;
  }
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157).trimEnd()}...`;
}

async function scanRoot(root: AgentSkillRoot): Promise<{
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
    readonly description?: string;
    readonly shortDescription?: string;
    readonly prompt?: string;
    readonly canonicalPath: string;
    readonly path: string;
    readonly installation: ServerSkillInstallation;
  }>;
  readonly issues: ReadonlyArray<ServerSkillCatalogIssue>;
}> {
  let dirents;
  try {
    dirents = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return { entries: [], issues: [] };
    }
    return {
      entries: [],
      issues: [
        issue(
          "directory-unreadable",
          root.path,
          `Unable to read skills directory: ${String(error)}`,
        ),
      ],
    };
  }

  const entries = [];
  const issues: ServerSkillCatalogIssue[] = [];
  for (const dirent of dirents.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
      continue;
    }
    if (dirent.name.startsWith(".")) {
      continue;
    }

    const skillPath = join(root.path, dirent.name);
    const canonicalPath = await realpath(skillPath).catch(() => normalize(skillPath));
    const skillFilePath = join(canonicalPath, SKILL_FILE_NAME);
    let content: string;
    try {
      content = await readFile(skillFilePath, "utf8");
    } catch (error) {
      if (!isMissingDirectoryError(error)) {
        issues.push(
          issue("skill-unreadable", skillFilePath, `Unable to read SKILL.md: ${String(error)}`),
        );
      }
      continue;
    }

    const metadata = parseSkillFrontmatter(content);
    if (!metadata) {
      issues.push(issue("skill-malformed", skillFilePath, "SKILL.md is missing YAML frontmatter."));
    }
    const id = basename(skillPath);
    const name = metadata?.name ?? id;
    const description = metadata?.description;
    const prompt = extractSkillPrompt(content);
    const catalogEntry = {
      id,
      name,
      displayName: name,
      canonicalPath,
      path: skillPath,
      installation: {
        agentId: root.agentId,
        agentName: root.agentName,
        path: skillPath,
        source: root.source,
      },
    };
    if (description || prompt) {
      entries.push({
        ...catalogEntry,
        ...(description
          ? { description, shortDescription: shortDescriptionFromDescription(description) }
          : {}),
        ...(prompt ? { prompt } : {}),
      });
    } else {
      entries.push(catalogEntry);
    }
  }

  return { entries, issues };
}

export async function listServerSkills(input: { readonly homeDir?: string } = {}): Promise<{
  readonly skills: ServerSkillCatalogEntry[];
  readonly issues: ServerSkillCatalogIssue[];
}> {
  const roots = listAgentSkillRoots(input);
  const scannedRoots = await Promise.all(roots.map((root) => scanRoot(root)));
  const catalog = new Map<string, MutableCatalogEntry>();
  const issuesByKey = new Map<string, ServerSkillCatalogIssue>();
  for (const catalogIssue of scannedRoots.flatMap((root) => root.issues)) {
    issuesByKey.set(
      `${catalogIssue.kind}:${catalogIssue.path}:${catalogIssue.message}`,
      catalogIssue,
    );
  }
  const issues = [...issuesByKey.values()];

  for (const scannedRoot of scannedRoots) {
    for (const skill of scannedRoot.entries) {
      const existing = catalog.get(skill.id);
      if (!existing) {
        catalog.set(skill.id, {
          id: skill.id,
          name: skill.name,
          displayName: skill.displayName,
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
          ...(skill.prompt ? { prompt: skill.prompt } : {}),
          canonicalPath: skill.canonicalPath,
          paths: new Set([skill.path, skill.canonicalPath]),
          installations: new Map([
            [`${skill.installation.agentId}:${skill.installation.path}`, skill.installation],
          ]),
        });
        continue;
      }

      existing.paths.add(skill.path);
      existing.paths.add(skill.canonicalPath);
      existing.installations.set(
        `${skill.installation.agentId}:${skill.installation.path}`,
        skill.installation,
      );
      if (!existing.description && skill.description) {
        existing.description = skill.description;
        if (skill.shortDescription) {
          existing.shortDescription = skill.shortDescription;
        }
      }
      if (!existing.prompt && skill.prompt) {
        existing.prompt = skill.prompt;
      }
    }
  }

  return {
    skills: [...catalog.values()]
      .map((skill) => {
        const paths = [...skill.paths].toSorted((left, right) => left.localeCompare(right));
        const catalogEntry: Mutable<ServerSkillCatalogEntry> = {
          id: skill.id,
          name: skill.name,
          displayName: skill.displayName,
          canonicalPath: skill.canonicalPath,
          paths,
          installations: [...skill.installations.values()].toSorted(
            (left, right) =>
              left.agentName.localeCompare(right.agentName) || left.path.localeCompare(right.path),
          ),
          hasPathConflict: new Set(paths.map((path) => normalize(path))).size > 2,
        };
        if (skill.description) {
          catalogEntry.description = skill.description;
        }
        if (skill.shortDescription) {
          catalogEntry.shortDescription = skill.shortDescription;
        }
        if (skill.prompt) {
          catalogEntry.prompt = skill.prompt;
        }
        return catalogEntry;
      })
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName)),
    issues,
  };
}
