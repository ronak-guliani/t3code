export interface SkillFrontmatterMetadata {
  readonly name?: string;
  readonly description?: string;
}

function trimYamlScalar(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function parseBlockScalar(
  lines: readonly string[],
  startIndex: number,
): {
  readonly value: string;
  readonly nextIndex: number;
} {
  const blockLines: string[] = [];
  let index = startIndex + 1;
  let blockIndent: number | null = null;

  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      blockLines.push("");
      continue;
    }

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (blockIndent === null) {
      blockIndent = indent;
    }
    if (indent < blockIndent) {
      break;
    }
    blockLines.push(line.slice(blockIndent));
  }

  return { value: blockLines.join("\n").trim(), nextIndex: index };
}

function foldBlockScalar(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function parseYamlScalar(
  lines: readonly string[],
  index: number,
  prefix: "name:" | "description:",
): { readonly value: string; readonly nextIndex: number } {
  const rawValue = lines[index]!.trim().slice(prefix.length);
  const scalar = trimYamlScalar(rawValue);
  if (scalar === ">" || scalar === "|") {
    const block = parseBlockScalar(lines, index);
    return {
      value: scalar === ">" ? foldBlockScalar(block.value) : block.value,
      nextIndex: block.nextIndex,
    };
  }
  return { value: scalar, nextIndex: index + 1 };
}

export function extractSkillFrontmatter(content: string): string | null {
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

export function extractSkillPrompt(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return content.trim();
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex < 2) {
    return content.trim();
  }
  return lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
}

export function parseSkillFrontmatter(content: string): SkillFrontmatterMetadata | null {
  const frontmatter = extractSkillFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  let name: string | undefined;
  let description: string | undefined;
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      const parsed = parseYamlScalar(lines, index, "name:");
      const value = parsed.value;
      if (value.length > 0) {
        name = value;
      }
      index = parsed.nextIndex;
      continue;
    }
    if (trimmed.startsWith("description:")) {
      const parsed = parseYamlScalar(lines, index, "description:");
      const value = parsed.value;
      if (value.length > 0) {
        description = value;
      }
      index = parsed.nextIndex;
      continue;
    }
    index++;
  }

  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}
