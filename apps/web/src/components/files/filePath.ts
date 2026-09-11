export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export type CollapsedBreadcrumb = FileBreadcrumb | { label: "…"; path: ""; kind: "ellipsis" };

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  return [
    { label: projectName, path: "", kind: "project" },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
      kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
}

/**
 * Collapses deep breadcrumb trails to `project / … / parent / file` so the
 * file preview header no longer duplicates the full tab-bar path.
 */
export function collapseBreadcrumbs(crumbs: FileBreadcrumb[]): CollapsedBreadcrumb[] {
  if (crumbs.length <= 4) return crumbs;
  const first = crumbs[0];
  const lastTwo = crumbs.slice(-2);
  if (!first || lastTwo.length !== 2) return crumbs;
  return [first, { label: "…", path: "", kind: "ellipsis" }, ...lastTwo];
}
