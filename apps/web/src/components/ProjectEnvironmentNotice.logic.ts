import type { EnvironmentId } from "@t3tools/contracts";
import type { Project } from "../types";

// This is a possible-mismatch hint, never an assertion that matching names are the same repository.
export function findOtherProjectEnvironments(
  projects: readonly Project[],
  environmentId: EnvironmentId,
  projectName: string,
): readonly Project[] {
  return projects.filter(
    (project) => project.environmentId !== environmentId && project.name === projectName,
  );
}
