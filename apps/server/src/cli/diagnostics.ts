import { discoverLocalEnvironments, type LocalEnvironment } from "@t3tools/shared/localEnvironment";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { installationIdentity } from "./installation.ts";
import {
  readLiveThread,
  readLocalThreadForDiagnostics,
  resolveLiveTarget,
  type LocalThreadDiagnosticSnapshot,
  type CliLiveTargetFlags,
  type ResolvedCliLiveTarget,
} from "./client.ts";
import {
  readLocalServerEvidence,
  readProviderEventEvidence,
  summarizeThreadDiagnostic,
  type CorrelatedServerEvidence,
  type ProviderDiagnosticEvent,
  type ProviderEventEvidence,
} from "./threadDiagnostics.ts";

class CliThreadNotFoundError extends Schema.TaggedErrorClass<CliThreadNotFoundError>()(
  "CliThreadNotFoundError",
  { message: Schema.String },
) {}

class CliThreadAmbiguousError extends Schema.TaggedErrorClass<CliThreadAmbiguousError>()(
  "CliThreadAmbiguousError",
  { message: Schema.String },
) {}

class CliThreadDiscoveryIncompleteError extends Schema.TaggedErrorClass<CliThreadDiscoveryIncompleteError>()(
  "CliThreadDiscoveryIncompleteError",
  { message: Schema.String },
) {}

const baseDirFlag = Flag.string("base-dir").pipe(Flag.optional);
const urlFlag = Flag.string("url").pipe(Flag.optional);
const tokenFlag = Flag.string("token").pipe(Flag.optional);
const environmentFlag = Flag.string("environment").pipe(Flag.optional);
const unavailableServerEvidence: CorrelatedServerEvidence = {
  serverLogs: { available: false, truncated: false, files: [], scannedBytes: 0, records: [] },
  traces: { available: false, truncated: false, files: [], scannedBytes: 0, spans: [] },
};

const selectionFlags = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly url: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly environment: Option.Option<string>;
}): CliLiveTargetFlags => ({
  baseDir: flags.baseDir,
  url: flags.url,
  token: flags.token,
  environment: flags.environment,
});

const safeTarget = (
  target: ResolvedCliLiveTarget,
  environment?: {
    readonly baseDir?: string;
    readonly stateDirectory?: "userdata" | "dev";
    readonly serverVersion: string | null;
    readonly serverBuildRevision: string | null;
  },
) => ({
  kind: target.kind,
  source: target.source,
  selectionReason: target.selectionReason,
  ...(environment?.baseDir === undefined
    ? target.baseDir === undefined
      ? {}
      : { cliConfigBaseDir: target.baseDir }
    : {
        baseDir: environment.baseDir,
        ...(environment.stateDirectory === undefined
          ? {}
          : { stateDirectory: environment.stateDirectory }),
      }),
  ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
  ...("origin" in target ? { origin: target.origin } : {}),
  ...(target.label === undefined ? {} : { label: target.label }),
  server: environment
    ? { version: environment.serverVersion, buildRevision: environment.serverBuildRevision }
    : null,
});

const renderTarget = (
  identity: ReturnType<typeof installationIdentity>,
  target: ReturnType<typeof safeTarget>,
) =>
  [
    `CLI: ${identity.distribution} ${identity.version} (${identity.commit ?? "commit unknown"})`,
    `Executable: ${identity.entrypoint}`,
    `Target: ${target.label ?? target.environmentId ?? target.origin ?? target.kind}`,
    `Selected by: ${target.selectionReason} (${target.source})`,
    ...("baseDir" in target && target.baseDir !== undefined
      ? [`Data directory: ${target.baseDir}`]
      : []),
    ...(target.environmentId === undefined ? [] : [`Environment ID: ${target.environmentId}`]),
    ...(target.server === null
      ? ["Server build: unavailable"]
      : [`Server build: ${target.server.version} (${target.server.buildRevision ?? "unknown"})`]),
    ...("cliConfigBaseDir" in target && target.cliConfigBaseDir
      ? [`CLI config directory: ${target.cliConfigBaseDir}`]
      : []),
  ].join("\n");

const inspectRemoteServerIdentity = (origin: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      });
      if (!response.ok) return null;
      const descriptor: unknown = await response.json();
      if (typeof descriptor !== "object" || descriptor === null) return null;
      const record = descriptor as Record<string, unknown>;
      return typeof record.serverVersion === "string"
        ? {
            serverVersion: record.serverVersion,
            serverBuildRevision:
              typeof record.buildRevision === "string" ? record.buildRevision : null,
          }
        : null;
    },
    catch: () => null,
  });

const targetExplainCommand = Command.make("explain", {
  baseDir: baseDirFlag,
  url: urlFlag,
  token: tokenFlag,
  environment: environmentFlag,
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Explain which T3 environment this executable selects."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const flags = selectionFlags(input);
      const selected = yield* Effect.result(resolveLiveTarget(flags));
      const target = selected._tag === "Success" ? selected.success : null;
      const environments = yield* Effect.tryPromise(() =>
        discoverLocalEnvironments([], undefined, { includeDevState: true }),
      );
      const local =
        target?.kind === "bearer"
          ? environments.environments.find(
              (candidate) =>
                candidate.baseDir === target.baseDir && candidate.origin === target.origin,
            )
          : undefined;
      const remoteIdentity =
        target?.kind === "bearer" && local === undefined
          ? yield* inspectRemoteServerIdentity(target.origin)
          : null;
      const identity = installationIdentity();
      const shownTarget =
        target === null
          ? null
          : safeTarget(
              target,
              local ??
                (remoteIdentity === null
                  ? undefined
                  : {
                      serverVersion: remoteIdentity.serverVersion,
                      serverBuildRevision: remoteIdentity.serverBuildRevision,
                    }),
            );
      const selectionError =
        selected._tag === "Failure"
          ? selected.failure instanceof Error
            ? selected.failure.message
            : String(selected.failure)
          : null;
      const knownLocalEnvironments = environments.environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        baseDir: environment.baseDir,
        stateDirectory: environment.stateDirectory,
        status: environment.status,
        origin: environment.origin,
        pid: environment.pid,
        serverVersion: environment.serverVersion,
        serverBuildRevision: environment.serverBuildRevision,
        error: environment.error,
      }));
      if (input.json) {
        yield* Console.log(
          JSON.stringify(
            {
              cli: identity,
              selectedTarget: shownTarget,
              selectionError,
              environmentSelectionError: environments.selectionError,
              knownLocalEnvironments,
            },
            null,
            2,
          ),
        );
      } else {
        yield* Console.log(
          [
            `CLI: ${identity.distribution} ${identity.version} (${identity.commit ?? "commit unknown"})`,
            `Executable: ${identity.entrypoint}`,
            ...(shownTarget === null
              ? [
                  `Selected target: none`,
                  ...(selectionError ? [`Selection error: ${selectionError}`] : []),
                ]
              : renderTarget(identity, shownTarget).split("\n").slice(2)),
            `Known local environments (${knownLocalEnvironments.length}):`,
            ...knownLocalEnvironments.map(
              (environment) =>
                `  ${environment.label} [${environment.environmentId}] ${environment.status} — ${environment.baseDir}/${environment.stateDirectory}`,
            ),
          ].join("\n"),
        );
      }
    }).pipe(Effect.timeout("10 seconds")),
  ),
);

export const targetCommand = Command.make("target").pipe(
  Command.withDescription("Inspect CLI and server target selection."),
  Command.withSubcommands([targetExplainCommand]),
);

const localTargetCandidates = (input: {
  readonly baseDir: Option.Option<string>;
  readonly localEnvironment: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const explicitBaseDir = Option.getOrUndefined(input.baseDir);
    const discovery = yield* Effect.tryPromise(() =>
      discoverLocalEnvironments(explicitBaseDir === undefined ? [] : [explicitBaseDir], undefined, {
        includeDevState: true,
      }),
    );
    let candidates = discovery.environments;
    if (explicitBaseDir !== undefined) {
      const explicitPath = yield* Effect.tryPromise(() => realpath(explicitBaseDir));
      candidates = candidates.filter((candidate) => candidate.baseDir === explicitPath);
    }
    if (Option.isSome(input.localEnvironment)) {
      const selector = input.localEnvironment.value;
      candidates = candidates.filter(
        (candidate) => candidate.environmentId === selector || candidate.label === selector,
      );
    }
    if (Option.isSome(input.localEnvironment) && candidates.length === 0) {
      return yield* new CliThreadNotFoundError({
        message: `No known local environment matches '${input.localEnvironment.value}'. Run 't3 target explain --json' to inspect available environments.`,
      });
    }
    return { candidates, selectionError: discovery.selectionError };
  });

const isThreadNotFound = (cause: unknown): boolean =>
  cause instanceof Error && /thread.*not found/i.test(cause.message);

const localThreadMatches = (input: {
  readonly threadId: string;
  readonly candidates: ReadonlyArray<LocalEnvironment>;
  readonly allowUnavailable: boolean;
}) =>
  Effect.gen(function* () {
    const matches: Array<{
      readonly environment: (typeof input.candidates)[number];
      readonly thread: LocalThreadDiagnosticSnapshot["thread"];
      readonly messages: LocalThreadDiagnosticSnapshot["messages"];
      readonly messagesComplete: boolean;
      readonly providerEvidence: ProviderEventEvidence;
      readonly serverEvidence: CorrelatedServerEvidence;
    }> = [];
    const failures: Array<{ readonly environment: string; readonly message: string }> = [];

    for (const environment of input.candidates) {
      if (environment.status === "unavailable" && !input.allowUnavailable) {
        failures.push({
          environment: `${environment.label} (${environment.environmentId})`,
          message:
            environment.error ??
            "Local server state is unavailable; no direct database read was attempted.",
        });
        continue;
      }
      const detail = yield* Effect.result(
        readLocalThreadForDiagnostics(
          environment.baseDir,
          environment.stateDirectory,
          input.threadId,
        ),
      );
      if (detail._tag === "Failure") {
        if (!isThreadNotFound(detail.failure)) {
          failures.push({
            environment: `${environment.label} (${environment.environmentId})`,
            message: detail.failure.message,
          });
        }
        continue;
      }

      const turnId = detail.success.thread.latestTurn?.turnId;
      const providerEvidence = turnId
        ? yield* Effect.tryPromise(() =>
            readProviderEventEvidence({
              providerLogsDir: join(
                environment.baseDir,
                environment.stateDirectory,
                "logs",
                "provider",
              ),
              threadId: input.threadId,
              turnId,
            }),
          ).pipe(
            Effect.timeout("5 seconds"),
            Effect.catch(() =>
              Effect.succeed({
                available: false,
                truncated: false,
                files: [],
                scannedBytes: 0,
                events: [],
              } satisfies ProviderEventEvidence),
            ),
          )
        : ({
            available: false,
            truncated: false,
            files: [],
            scannedBytes: 0,
            events: [],
          } satisfies ProviderEventEvidence);
      const serverEvidence = turnId
        ? yield* Effect.tryPromise(() =>
            readLocalServerEvidence({
              logsDir: join(environment.baseDir, environment.stateDirectory, "logs"),
              threadId: input.threadId,
              turnId,
            }),
          ).pipe(
            Effect.timeout("5 seconds"),
            Effect.catch(() => Effect.succeed(unavailableServerEvidence)),
          )
        : unavailableServerEvidence;
      matches.push({
        environment,
        ...detail.success,
        providerEvidence,
        serverEvidence,
      });
    }

    return { matches, failures };
  });

export const resolveUniqueLocalThreadMatch = <Match>(
  matches: ReadonlyArray<Match>,
  failures: ReadonlyArray<unknown>,
):
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Unique"; readonly match: Match } =>
  failures.length > 0
    ? { _tag: "Incomplete" }
    : matches.length === 0
      ? { _tag: "Missing" }
      : matches.length > 1
        ? { _tag: "Ambiguous" }
        : { _tag: "Unique", match: matches[0]! };

const readRemoteThread = (flags: CliLiveTargetFlags, threadId: string) =>
  Effect.gen(function* () {
    const summary = yield* readLiveThread(flags, { thread: threadId, view: "summary" });
    const messages: Array<{ readonly role: string; readonly turnId: string | null }> = [];
    let before: string | undefined;
    let messagesComplete = false;
    for (let index = 0; index < 10; index += 1) {
      const page = yield* readLiveThread(flags, {
        thread: threadId,
        view: "messages",
        limit: 200,
        ...(before === undefined ? {} : { before }),
      });
      for (const message of page.messages ?? []) {
        messages.push({ role: message.role, turnId: message.turnId });
      }
      if (!page.page.hasMore) {
        messagesComplete = true;
        break;
      }
      if (page.page.before === null) break;
      before = page.page.before;
    }
    return { thread: summary.thread, messages, messagesComplete };
  });

const toProviderDiagnosticEvents = (
  threadId: string,
  evidence: ProviderEventEvidence,
): ReadonlyArray<ProviderDiagnosticEvent> =>
  evidence.events.map((event) => ({
    stream: event.stream,
    threadId,
    event: {
      type: event.type,
      eventId: event.eventId,
      turnId: event.turnId,
      createdAt: event.createdAt,
      assistantTextObserved: event.assistantTextObserved,
      payload: { state: event.state, stopReason: event.stopReason },
    },
  }));

const threadCommand = Command.make("thread", {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Exact T3 thread id.")),
  baseDir: baseDirFlag,
  localEnvironment: Flag.string("local-environment").pipe(
    Flag.optional,
    Flag.withDescription("Limit local discovery to an environment id or exact label."),
  ),
  url: urlFlag,
  token: tokenFlag,
  environment: environmentFlag,
  timeline: Flag.boolean("timeline").pipe(Flag.withDefault(false)),
  include: Flag.choice("include", ["provider"]).pipe(Flag.optional),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Correlate a thread turn with provider and persisted-message evidence."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const isExplicitRemote =
        Option.isSome(input.url) || Option.isSome(input.token) || Option.isSome(input.environment);
      if (
        isExplicitRemote &&
        (Option.isSome(input.baseDir) || Option.isSome(input.localEnvironment))
      ) {
        return yield* new CliThreadAmbiguousError({
          message: "Use either a local target selector or --url/--environment, not both.",
        });
      }

      let thread: LocalThreadDiagnosticSnapshot["thread"];
      let messages: LocalThreadDiagnosticSnapshot["messages"];
      let messagesComplete: boolean;
      let providerEvidence: ProviderEventEvidence;
      let serverEvidence: CorrelatedServerEvidence;
      let target:
        | ReturnType<typeof safeTarget>
        | {
            readonly kind: "local";
            readonly source: string;
            readonly selectionReason: string;
            readonly baseDir: string;
            readonly stateDirectory: "userdata" | "dev";
            readonly environmentStatus: LocalEnvironment["status"];
            readonly environmentWarning: string | null;
            readonly environmentId: string;
            readonly label: string;
            readonly server: {
              readonly version: string | null;
              readonly buildRevision: string | null;
            };
          };
      let selectionDetails: Record<string, unknown>;

      if (isExplicitRemote) {
        const flags = selectionFlags(input);
        const selected = yield* resolveLiveTarget(flags);
        const result = yield* readRemoteThread(flags, input.threadId);
        thread = result.thread;
        messages = result.messages;
        messagesComplete = result.messagesComplete;
        providerEvidence = {
          available: false,
          truncated: false,
          files: [],
          scannedBytes: 0,
          events: [],
        };
        serverEvidence = unavailableServerEvidence;
        target = safeTarget(selected);
        selectionDetails = { mode: "explicit", reason: selected.selectionReason };
      } else {
        const discovery = yield* localTargetCandidates(input);
        const { matches, failures } = yield* localThreadMatches({
          threadId: input.threadId,
          candidates: discovery.candidates,
          allowUnavailable: Option.isSome(input.baseDir) || Option.isSome(input.localEnvironment),
        });
        const selection = resolveUniqueLocalThreadMatch(matches, failures);
        if (selection._tag === "Incomplete") {
          return yield* new CliThreadDiscoveryIncompleteError({
            message:
              `Could not inspect every known local environment while resolving thread ${input.threadId}. ` +
              `${failures.map((failure) => `${failure.environment}: ${failure.message}`).join("; ")} ` +
              "Use --local-environment or --base-dir to pin the read-only inspection.",
          });
        }
        if (selection._tag === "Missing") {
          return yield* new CliThreadNotFoundError({
            message:
              `Thread '${input.threadId}' was not found in ${discovery.candidates.length} known local environment(s). ` +
              "Run 't3 target explain --json' to inspect known local environments, or pass --base-dir to pin one explicitly.",
          });
        }
        if (selection._tag === "Ambiguous") {
          return yield* new CliThreadAmbiguousError({
            message:
              `Thread '${input.threadId}' exists in multiple local environments: ` +
              matches
                .map(
                  ({ environment }) =>
                    `${environment.label} [${environment.environmentId}, ${environment.baseDir}/${environment.stateDirectory}]`,
                )
                .join("; ") +
              ". Use --local-environment <id> or --base-dir to choose explicitly.",
          });
        }

        const match = selection.match;
        thread = match.thread;
        messages = match.messages;
        messagesComplete = match.messagesComplete;
        providerEvidence = match.providerEvidence;
        serverEvidence = match.serverEvidence;
        target = {
          kind: "local",
          source:
            Option.isSome(input.baseDir) || Option.isSome(input.localEnvironment)
              ? "explicit-local-selection"
              : "unique-thread-match",
          selectionReason: Option.isSome(input.baseDir)
            ? "--base-dir"
            : Option.isSome(input.localEnvironment)
              ? "--local-environment"
              : "unique thread id match",
          baseDir: match.environment.baseDir,
          stateDirectory: match.environment.stateDirectory,
          environmentStatus: match.environment.status,
          environmentWarning: match.environment.error,
          environmentId: match.environment.environmentId,
          label: match.environment.label,
          server: {
            version: match.environment.serverVersion,
            buildRevision: match.environment.serverBuildRevision,
          },
        };
        selectionDetails = {
          mode: "local-discovery",
          candidatesInspected: discovery.candidates.length,
          selectionError: discovery.selectionError,
        };
      }

      const turn = thread.latestTurn;
      const diagnostic = summarizeThreadDiagnostic({
        threadId: input.threadId,
        latestTurn: turn
          ? {
              turnId: turn.turnId,
              state: turn.state,
              assistantMessageId: turn.assistantMessageId,
            }
          : null,
        messages,
        messagesComplete,
        providerEvents: turn ? toProviderDiagnosticEvents(input.threadId, providerEvidence) : [],
        providerEvidence,
      });
      const identity = installationIdentity();
      const providerEvents = toProviderDiagnosticEvents(input.threadId, providerEvidence).map(
        (entry) => {
          const event = entry.event as Record<string, unknown>;
          const payload = event.payload as Record<string, unknown>;
          return {
            stream: entry.stream,
            type: event.type,
            turnId: event.turnId,
            createdAt: event.createdAt,
            state: payload.state,
            stopReason: payload.stopReason,
            assistantTextObserved: event.assistantTextObserved,
          };
        },
      );
      const timelineEvents = [
        ...providerEvents.map((event) => ({
          timestamp: event.createdAt,
          source: "provider",
          stream: event.stream,
          type: event.type,
          turnId: event.turnId,
          stopReason: event.stopReason,
          assistantTextObserved: event.assistantTextObserved,
        })),
        ...serverEvidence.serverLogs.records.map((event) => ({
          timestamp: event.timestamp,
          source: "server-log",
          level: event.level,
          spanNames: event.spanNames,
        })),
        ...serverEvidence.traces.spans.map((span) => ({
          timestamp: span.startedAt,
          source: "trace",
          name: span.name,
          traceId: span.traceId,
          durationMs: span.durationMs,
          outcome: span.outcome,
        })),
      ].toSorted((left, right) => {
        const leftTime =
          typeof left.timestamp === "string"
            ? Date.parse(left.timestamp)
            : Number.POSITIVE_INFINITY;
        const rightTime =
          typeof right.timestamp === "string"
            ? Date.parse(right.timestamp)
            : Number.POSITIVE_INFINITY;
        return leftTime - rightTime;
      });
      const result = {
        cli: identity,
        target,
        selection: selectionDetails,
        thread: {
          id: thread.id,
          title: thread.title,
          latestTurn: turn,
        },
        diagnostic,
        evidence: {
          providerLogs: {
            available: providerEvidence.available,
            truncated: providerEvidence.truncated,
            files: providerEvidence.files,
            scannedBytes: providerEvidence.scannedBytes,
          },
          serverLogs: {
            available: serverEvidence.serverLogs.available,
            truncated: serverEvidence.serverLogs.truncated,
            files: serverEvidence.serverLogs.files,
            scannedBytes: serverEvidence.serverLogs.scannedBytes,
            matchedRecords: serverEvidence.serverLogs.records.length,
          },
          traces: {
            available: serverEvidence.traces.available,
            truncated: serverEvidence.traces.truncated,
            files: serverEvidence.traces.files,
            scannedBytes: serverEvidence.traces.scannedBytes,
            matchedSpans: serverEvidence.traces.spans.length,
          },
          messageHistoryComplete: messagesComplete,
        },
        ...(Option.isSome(input.include) && input.include.value === "provider"
          ? { providerEvents }
          : {}),
        ...(input.timeline ? { timeline: timelineEvents } : {}),
      };

      if (input.json) {
        yield* Console.log(JSON.stringify(result, null, 2));
      } else {
        yield* Console.log(
          [
            `CLI: ${identity.distribution} ${identity.version} (${identity.commit ?? "commit unknown"})`,
            `Target: ${"label" in target ? target.label : (target.environmentId ?? target.kind)}`,
            `Selected by: ${target.selectionReason}`,
            ...("environmentStatus" in target
              ? [
                  `Environment status: ${target.environmentStatus}${target.environmentWarning ? ` (${target.environmentWarning})` : ""}`,
                ]
              : []),
            ...("baseDir" in target && typeof target.baseDir === "string"
              ? [
                  `Data directory: ${target.baseDir}${"stateDirectory" in target ? `/${target.stateDirectory}` : ""}`,
                ]
              : []),
            ...(target.server === null
              ? ["Server build: unavailable"]
              : target.server.version === null
                ? ["Server build: unknown"]
                : [
                    `Server build: ${target.server.version} (${target.server.buildRevision ?? "unknown"})`,
                  ]),
            `Thread: ${thread.title} (${thread.id})`,
            `Turn: ${diagnostic.turn?.state ?? "none"}`,
            `Provider completion: ${diagnostic.provider.completion ?? "unknown"}`,
            `Provider assistant text: ${diagnostic.provider.assistantText}`,
            `Persisted assistant message: ${diagnostic.persistence.assistantMessage}`,
            `Response persistence: ${diagnostic.response}`,
            `Provider evidence: ${providerEvidence.available ? providerEvidence.files.join(", ") : "unavailable"}${providerEvidence.truncated ? " (scan incomplete)" : ""}`,
            `Server logs: ${serverEvidence.serverLogs.records.length} correlated record(s)${serverEvidence.serverLogs.truncated ? " (scan incomplete)" : ""}`,
            `Traces: ${serverEvidence.traces.spans.length} correlated span(s)${serverEvidence.traces.truncated ? " (scan incomplete)" : ""}`,
            ...(input.timeline
              ? [
                  "Correlated timeline:",
                  ...timelineEvents.map(
                    (event) =>
                      `  ${event.timestamp ?? "unknown time"} ${event.source}${"stream" in event ? ` ${event.stream} ${event.type ?? "unknown"}` : "level" in event ? ` ${event.level ?? "unknown"}` : ` ${event.name}`}`,
                  ),
                ]
              : Option.isSome(input.include) && input.include.value === "provider"
                ? [
                    "Provider events:",
                    ...providerEvents.map(
                      (event) =>
                        `  ${event.createdAt ?? "unknown time"} ${event.stream} ${event.type ?? "unknown"}${event.stopReason ? ` (${String(event.stopReason)})` : ""}`,
                    ),
                  ]
                : []),
          ].join("\n"),
        );
      }
    }).pipe(Effect.timeout("30 seconds")),
  ),
);

export const diagnosticsThreadCommand = threadCommand;
