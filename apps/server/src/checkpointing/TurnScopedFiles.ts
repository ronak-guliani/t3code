import {
  type OrchestrationCheckpointFile,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import {
  extractNormalizedChangedFilePathsFromToolPayload,
  normalizeChangedFilePath,
} from "@t3tools/shared/toolChangedFiles";

const TURN_SCOPED_ACTIVITY_KINDS = new Set(["tool.updated", "tool.completed"]);
const MAX_TURN_SCOPED_PATHS = 500;

export interface DeriveTurnScopedCheckpointFilesInput {
  readonly snapshotFiles: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly providerTouchedPaths?: ReadonlyArray<string>;
  readonly turnId: TurnId;
  readonly cwd: string;
}

export interface DeriveTurnScopedCheckpointFilesResult {
  readonly agentTouchedPaths: ReadonlyArray<string>;
  readonly turnFiles: ReadonlyArray<OrchestrationCheckpointFile>;
}

export function deriveTurnScopedCheckpointFiles(
  input: DeriveTurnScopedCheckpointFilesInput,
): DeriveTurnScopedCheckpointFilesResult {
  const touched = new Set<string>();
  for (const filePath of input.providerTouchedPaths ?? []) {
    const normalizedPath = normalizeChangedFilePath(filePath, { cwd: input.cwd });
    if (normalizedPath === null) {
      continue;
    }
    touched.add(normalizedPath);
    if (touched.size >= MAX_TURN_SCOPED_PATHS) {
      break;
    }
  }

  for (const activity of input.activities) {
    if (touched.size >= MAX_TURN_SCOPED_PATHS) {
      break;
    }
    if (activity.turnId !== input.turnId || !TURN_SCOPED_ACTIVITY_KINDS.has(activity.kind)) {
      continue;
    }

    for (const filePath of extractNormalizedChangedFilePathsFromToolPayload(activity.payload, {
      cwd: input.cwd,
      maxPaths: MAX_TURN_SCOPED_PATHS,
    })) {
      touched.add(filePath);
      if (touched.size >= MAX_TURN_SCOPED_PATHS) {
        break;
      }
    }

    if (touched.size >= MAX_TURN_SCOPED_PATHS) {
      break;
    }
  }

  const turnFiles = input.snapshotFiles.filter((file) => {
    const normalizedPath = normalizeChangedFilePath(file.path);
    return normalizedPath !== null && touched.has(normalizedPath);
  });

  return {
    agentTouchedPaths: [...touched],
    turnFiles,
  };
}
