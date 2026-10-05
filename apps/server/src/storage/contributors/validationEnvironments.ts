/**
 * Leftover validation environments. A record is reclaimed only when it proves
 * T3 wrote it for that exact state directory and every recorded owner process
 * is gone. Anything weaker is listed for manual review; nothing is ever
 * killed, and nothing is matched by directory name or cwd alone.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type {
  StorageCleanupItem,
  StorageCleanupItemResult,
  ValidationTarget,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { ServerConfig } from "../../config.ts";
import { resolveBrowserEvidenceDir } from "../../mcp/PreviewEvidence.ts";
import { validationEnvironmentStateDirectory } from "../../validation/ValidationEnvironmentService.ts";
import { measureDirectory } from "../measureDirectory.ts";
import type { StorageCleanupContributor, StoragePlanEntry } from "../StorageCleanup.ts";

const STATE_FILE = "validation-environment.json";
const ARTIFACTS_DIRECTORY = "artifacts";

export type ValidationRecordClass =
  | { readonly kind: "live"; readonly reason: string }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "unproven"; readonly reason: string };

export interface ValidationRecordProbe {
  /** True when a process with this PID exists (or cannot be signalled). */
  readonly isProcessAlive: (pid: number) => boolean;
  readonly currentPid: number;
}

export const systemProcessProbe: ValidationRecordProbe = {
  currentPid: process.pid,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Classify one environment state directory from its record alone. */
export function classifyValidationRecord(input: {
  readonly baseDir: string;
  readonly directory: string;
  readonly raw: string | null;
  readonly probe: ValidationRecordProbe;
}): ValidationRecordClass {
  if (input.raw === null) return { kind: "unproven", reason: "no ownership record" };
  let record: unknown;
  try {
    record = JSON.parse(input.raw);
  } catch {
    return { kind: "unproven", reason: "ownership record is unreadable" };
  }
  if (!isRecord(record) || record.version !== 1 || !isRecord(record.target)) {
    return { kind: "unproven", reason: "unknown ownership record format" };
  }
  const target = record.target as unknown as ValidationTarget & { stateDirectory?: unknown };
  const ownership = record.ownershipIdentity;
  if (
    typeof ownership !== "string" ||
    typeof target.environmentIdentity !== "string" ||
    !ownership.startsWith(`${target.environmentIdentity}:`)
  ) {
    return { kind: "unproven", reason: "ownership identity does not match its environment" };
  }
  const directory = path.resolve(input.directory);
  if (
    typeof target.stateDirectory !== "string" ||
    path.resolve(target.stateDirectory) !== directory ||
    path.resolve(validationEnvironmentStateDirectory(input.baseDir, target)) !== directory
  ) {
    return { kind: "unproven", reason: "record does not belong to this directory" };
  }
  const pids: number[] = [];
  for (const role of ["backend", "web"] as const) {
    const endpoint = record[role];
    const processIdentity = isRecord(endpoint) ? endpoint.process : undefined;
    if (
      !isRecord(processIdentity) ||
      processIdentity.ownershipIdentity !== ownership ||
      !Number.isSafeInteger(processIdentity.pid) ||
      (processIdentity.pid as number) <= 0
    ) {
      return { kind: "unproven", reason: `${role} process is not bound to this record` };
    }
    pids.push(processIdentity.pid as number);
  }
  if (pids.includes(input.probe.currentPid)) {
    return { kind: "live", reason: "owned by this running server" };
  }
  const alive = pids.filter((pid) => input.probe.isProcessAlive(pid));
  if (alive.length > 0) {
    return {
      kind: "unproven",
      reason: `process ${alive.join(", ")} is running; it cannot be proven to be the recorded owner`,
    };
  }
  return { kind: "stale", reason: "owning server is no longer running" };
}

interface EnvironmentDirectory {
  readonly directory: string;
  readonly raw: string | null;
  readonly classification: ValidationRecordClass;
}

interface ValidationPayload {
  readonly directory: string;
  readonly raw: string | null;
  readonly manual: boolean;
}

export const makeValidationStorageContributor = (
  probe: ValidationRecordProbe = systemProcessProbe,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const validationRoot = path.join(config.baseDir, "validation");

    const readEnvironment = async (directory: string): Promise<EnvironmentDirectory | null> => {
      const raw = await fs.readFile(path.join(directory, STATE_FILE), "utf8").catch(() => null);
      if (raw === null) {
        // Run-media directories hold only files; an environment directory
        // without its record is listed only if something is left inside.
        const entries = await fs.readdir(directory).catch(() => [] as string[]);
        if (entries.length === 0) return null;
      }
      return {
        directory,
        raw,
        classification: classifyValidationRecord({
          baseDir: config.baseDir,
          directory,
          raw,
          probe,
        }),
      };
    };

    const scan = Effect.promise(async () => {
      const environments = await fs
        .readdir(validationRoot, { withFileTypes: true })
        .catch(() => []);
      const candidates: string[] = [];
      for (const environment of environments) {
        if (!environment.isDirectory() || environment.name === ARTIFACTS_DIRECTORY) continue;
        const targets = await fs
          .readdir(path.join(validationRoot, environment.name), { withFileTypes: true })
          .catch(() => []);
        for (const target of targets) {
          if (target.isDirectory()) {
            candidates.push(path.join(validationRoot, environment.name, target.name));
          }
        }
      }
      const found = await Promise.all(candidates.map(readEnvironment));
      return found.filter((entry): entry is EnvironmentDirectory => entry !== null);
    });

    const toEntry = (
      environment: EnvironmentDirectory,
      bytes: number,
    ): StoragePlanEntry<ValidationPayload> | null => {
      if (environment.classification.kind === "live") return null;
      const manual = environment.classification.kind === "unproven";
      const item: StorageCleanupItem = {
        id: `validation:${environment.directory}`,
        category: "validationEnvironments",
        description: manual
          ? `Validation environment needs manual review: ${environment.classification.reason}`
          : `Stale validation environment (${environment.classification.reason})`,
        target: environment.directory,
        estimatedBytes: bytes,
        defaultSelected: !manual,
        needsManualReview: manual,
      };
      return { item, payload: { directory: environment.directory, raw: environment.raw, manual } };
    };

    const sizedEntries = (environments: ReadonlyArray<EnvironmentDirectory>) =>
      Effect.forEach(environments, (environment) =>
        Effect.promise(() => measureDirectory(environment.directory)).pipe(
          Effect.map((size) => toEntry(environment, size.bytes)),
        ),
      ).pipe(
        Effect.map((entries) =>
          entries.filter((entry): entry is StoragePlanEntry<ValidationPayload> => entry !== null),
        ),
      );

    const measure: StorageCleanupContributor["measure"] = ({
      signal,
      report,
      reportManualReview,
    }) =>
      Effect.gen(function* () {
        const environments = yield* scan;
        const environmentSizes = yield* Effect.forEach(environments, (environment) =>
          Effect.promise(() => measureDirectory(environment.directory, { signal })),
        );
        const environmentBytes = environmentSizes.reduce((sum, size) => sum + size.bytes, 0);
        const entries = environments.flatMap((environment, index) => {
          const entry = toEntry(environment, environmentSizes[index]!.bytes);
          return entry === null ? [] : [entry];
        });
        yield* reportManualReview(
          entries.filter((entry) => entry.payload.manual).map((entry) => entry.item),
        );
        yield* report({
          category: "validationEnvironments",
          status: "complete",
          bytes: environmentBytes,
          items: environments.length,
        });
        const [validationTotal, evidence] = yield* Effect.promise(() =>
          Promise.all([
            measureDirectory(validationRoot, { signal }),
            measureDirectory(resolveBrowserEvidenceDir(), { signal }),
          ]),
        );
        yield* report({
          category: "browserArtifacts",
          status: "complete",
          bytes: Math.max(0, validationTotal.bytes - environmentBytes) + evidence.bytes,
          items:
            Math.max(
              0,
              validationTotal.files - environmentSizes.reduce((sum, size) => sum + size.files, 0),
            ) + evidence.files,
        });
      });

    const plan: StorageCleanupContributor["plan"] = (_policy, mode) =>
      scan.pipe(
        Effect.flatMap((environments) => sizedEntries(environments)),
        Effect.map((entries) =>
          mode === "automatic" ? entries.filter((entry) => !entry.payload.manual) : entries,
        ),
      );

    const executeOne = (entry: StoragePlanEntry) =>
      Effect.gen(function* () {
        const payload = entry.payload as ValidationPayload;
        const result = (
          status: StorageCleanupItemResult["status"],
          reason: string,
        ): StorageCleanupItemResult => ({
          itemId: entry.item.id,
          category: entry.item.category,
          description: entry.item.description,
          status,
          bytesFreed: status === "removed" ? entry.item.estimatedBytes : 0,
          reason,
        });
        const current = yield* Effect.promise(() => readEnvironment(payload.directory));
        if (current === null) return result("skipped", "already gone");
        if (current.raw !== payload.raw) return result("skipped", "record changed since preview");
        if (current.classification.kind === "live") {
          return result("skipped", current.classification.reason);
        }
        if (current.classification.kind === "unproven" && !payload.manual) {
          return result("skipped", current.classification.reason);
        }
        // State only: recorded processes are never signalled from here.
        yield* Effect.promise(() => fs.rm(payload.directory, { recursive: true, force: true }));
        return result(
          "removed",
          payload.manual ? "removed after manual confirmation" : current.classification.reason,
        );
      });

    return {
      id: "validation",
      categories: ["validationEnvironments", "browserArtifacts"],
      measure,
      plan,
      execute: (entries) => Effect.forEach(entries, executeOne, { concurrency: 1 }),
    } satisfies StorageCleanupContributor;
  });
