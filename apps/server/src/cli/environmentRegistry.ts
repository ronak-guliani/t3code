import { randomUUID } from "node:crypto";

import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveBaseDir } from "../os-jank.ts";

export type CliEnvironmentEntry = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly token?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly secrets?: Record<string, string> | undefined;
};

export type CliEnvironmentSelection =
  | {
      readonly source: "manual";
      readonly id: string;
    }
  | {
      readonly source: "account";
      readonly accountId: string;
      readonly environmentId: string;
    };

export type CliEnvironmentRegistry = {
  readonly version: 2;
  readonly current?: CliEnvironmentSelection;
  readonly environments: Record<string, CliEnvironmentEntry>;
};

export type CliEnvironmentCandidate =
  | {
      readonly source: "manual";
      readonly id: string;
      readonly label: string;
      readonly profile: CliEnvironmentEntry;
    }
  | {
      readonly source: "account";
      readonly id: string;
      readonly label: string;
      readonly accountId: string;
      readonly environment: RelayClientEnvironmentRecord;
    };

const CliEnvironmentEntrySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  url: Schema.String,
  token: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  secrets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const CliEnvironmentSelectionSchema = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("manual"),
    id: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("account"),
    accountId: Schema.String,
    environmentId: Schema.String,
  }),
]);

const CliEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(2)),
  current: Schema.optional(Schema.Union([Schema.String, CliEnvironmentSelectionSchema])),
  environments: Schema.Record(Schema.String, CliEnvironmentEntrySchema),
});

const decodeRegistryDocument = Schema.decodeUnknownEffect(CliEnvironmentRegistryDocumentSchema);

export class CliEnvironmentRegistryError extends Schema.TaggedErrorClass<CliEnvironmentRegistryError>()(
  "CliEnvironmentRegistryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class CliEnvironmentSelectionError extends Schema.TaggedErrorClass<CliEnvironmentSelectionError>()(
  "CliEnvironmentSelectionError",
  {
    reason: Schema.Literals(["empty", "ambiguous", "not-found"]),
    message: Schema.String,
  },
) {}

export const emptyEnvironmentRegistry = (): CliEnvironmentRegistry => ({
  version: 2,
  environments: {},
});

export const environmentRegistryPath = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const resolvedBaseDir = yield* resolveBaseDir(
      Option.getOrUndefined(baseDir) ?? process.env.T3CODE_HOME,
    );
    const path = yield* Path.Path;
    return path.join(resolvedBaseDir, "cli-environments.json");
  });

export const readEnvironmentRegistry = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryPath = yield* environmentRegistryPath(baseDir);
    const exists = yield* fs.exists(registryPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return emptyEnvironmentRegistry();
    const raw = yield* fs.readFileString(registryPath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new CliEnvironmentRegistryError({
          message: `Invalid environment registry JSON: ${registryPath}`,
          cause,
        }),
    });
    const decoded = yield* decodeRegistryDocument(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new CliEnvironmentRegistryError({
            message: `Invalid environment registry: ${registryPath}`,
            cause,
          }),
      ),
    );
    const current =
      typeof decoded.current === "string"
        ? ({ source: "manual", id: decoded.current } as const)
        : decoded.current;
    return {
      version: 2,
      ...(current === undefined ? {} : { current }),
      environments: decoded.environments,
    } satisfies CliEnvironmentRegistry;
  });

const ENVIRONMENT_REGISTRY_FILE_MODE = 0o600;

export const writeEnvironmentRegistry = (
  baseDir: Option.Option<string>,
  registry: CliEnvironmentRegistry,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registryPath = yield* environmentRegistryPath(baseDir);
    const tempPath = `${registryPath}.${randomUUID()}.tmp`;
    yield* fs.makeDirectory(path.dirname(registryPath), { recursive: true });
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
        mode: ENVIRONMENT_REGISTRY_FILE_MODE,
      });
      yield* fs.chmod(tempPath, ENVIRONMENT_REGISTRY_FILE_MODE);
      yield* fs.rename(tempPath, registryPath);
      yield* fs.chmod(registryPath, ENVIRONMENT_REGISTRY_FILE_MODE);
    }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
  });

export const manualEnvironmentCandidates = (
  registry: CliEnvironmentRegistry,
): ReadonlyArray<CliEnvironmentCandidate> =>
  Object.values(registry.environments).map((profile) => ({
    source: "manual",
    id: profile.id,
    label: profile.label,
    profile,
  }));

export const accountEnvironmentCandidates = (
  accountId: string,
  environments: ReadonlyArray<RelayClientEnvironmentRecord>,
): ReadonlyArray<CliEnvironmentCandidate> =>
  environments.map((environment) => ({
    source: "account",
    id: environment.environmentId,
    label: environment.label,
    accountId,
    environment,
  }));

const qualifiedSelector = (candidate: CliEnvironmentCandidate): string =>
  `${candidate.source}:${candidate.id}`;

const ambiguousSelection = (selector: string, candidates: ReadonlyArray<CliEnvironmentCandidate>) =>
  new CliEnvironmentSelectionError({
    reason: "ambiguous",
    message:
      `Environment selector '${selector}' is ambiguous: ` +
      `${candidates.map(qualifiedSelector).join(", ")}. Use a source-qualified selector.`,
  });

export function resolveEnvironmentCandidate(
  selector: string,
  candidates: ReadonlyArray<CliEnvironmentCandidate>,
): CliEnvironmentCandidate {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new CliEnvironmentSelectionError({
      reason: "empty",
      message: "Environment selector cannot be empty.",
    });
  }

  const separator = trimmed.indexOf(":");
  const source =
    separator > 0 &&
    (trimmed.slice(0, separator) === "manual" || trimmed.slice(0, separator) === "account")
      ? (trimmed.slice(0, separator) as CliEnvironmentCandidate["source"])
      : undefined;
  const value = source === undefined ? trimmed : trimmed.slice(separator + 1);
  const scoped =
    source === undefined ? candidates : candidates.filter((entry) => entry.source === source);
  const exactIds = scoped.filter((entry) => entry.id === value);
  if (exactIds.length === 1) return exactIds[0]!;
  if (exactIds.length > 1) throw ambiguousSelection(trimmed, exactIds);

  const normalized = value.toLocaleLowerCase();
  const labels = scoped.filter((entry) => entry.label.toLocaleLowerCase() === normalized);
  if (labels.length === 1) return labels[0]!;
  if (labels.length > 1) throw ambiguousSelection(trimmed, labels);

  throw new CliEnvironmentSelectionError({
    reason: "not-found",
    message: `Environment '${selector}' not found.`,
  });
}

export const selectionForCandidate = (
  candidate: CliEnvironmentCandidate,
): CliEnvironmentSelection =>
  candidate.source === "manual"
    ? { source: "manual", id: candidate.id }
    : {
        source: "account",
        accountId: candidate.accountId,
        environmentId: candidate.environment.environmentId,
      };

export const candidateForSelection = (
  selection: CliEnvironmentSelection,
  candidates: ReadonlyArray<CliEnvironmentCandidate>,
): CliEnvironmentCandidate | undefined =>
  candidates.find((candidate) =>
    selection.source === "manual"
      ? candidate.source === "manual" && candidate.id === selection.id
      : candidate.source === "account" &&
        candidate.accountId === selection.accountId &&
        candidate.environment.environmentId === selection.environmentId,
  );

export const redactEnvironmentEntry = (entry: CliEnvironmentEntry) => ({
  ...entry,
  ...(entry.token !== undefined ? { token: "<redacted>" } : {}),
  ...(entry.secrets !== undefined
    ? { secrets: Object.fromEntries(Object.keys(entry.secrets).map((key) => [key, "<redacted>"])) }
    : {}),
});
