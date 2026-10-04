/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : name;
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${label} dependency '${name}'. Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [name, resolved];
    }),
  );
}

/**
 * Resolve dependencies for the standalone CLI package. Internal T3 workspace
 * packages are bundled into the CLI executable and must not remain as npm
 * `workspace:` dependencies in the published manifest.
 */
export function resolvePackagedCliDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(resolveCatalogDependencies(dependencies, catalog, label)).filter(
      ([, spec]) => !spec.startsWith("workspace:"),
    ),
  );
}
