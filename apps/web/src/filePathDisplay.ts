import { splitPathAndPosition } from "./terminal-links";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function splitNormalizedSegments(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Workspace-relative path for the integrated file viewer, or null when the
 * file lives outside the workspace root. Resolves `.`/`..` so paths like
 * `/repo/project/./report.html` still map to `report.html`.
 */
export function toWorkspaceRelativePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(filePath));
  const normalizedRoot = canonicalizeWindowsDrivePath(
    normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
  );
  if (!normalizedPath || !normalizedRoot) return null;
  const pathSegments = splitNormalizedSegments(normalizedPath);
  const rootSegments = splitNormalizedSegments(normalizedRoot);
  if (pathSegments.length <= rootSegments.length) return null;
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (pathSegments[index]?.toLowerCase() !== rootSegments[index]?.toLowerCase()) return null;
  }
  // Preserve the file's original casing in the returned relative path.
  // Re-resolve `.`/`..` in the suffix without lowercasing it.
  const resolved: string[] = [];
  for (const segment of normalizedPath.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const relative = resolved.slice(rootSegments.length);
  if (relative.length === 0) return null;
  return relative.join("/");
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
      normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
    );
    const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
    const pathForCompare = normalizedPath.toLowerCase();
    const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${workspaceLabel.toLowerCase()}/`;

    if (pathForCompare === workspaceForCompare) {
      displayPath = workspaceLabel;
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = `${workspaceLabel}/${relativeSuffix}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
}
