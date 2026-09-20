import type {
  DispatchReportVerdict,
  DispatchResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
  WorkflowRunId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import { canonicalizeWorktreePath, resolveGitWorktreeRoot } from "../../git/worktreePaths.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { runProcess } from "../../processRunner.ts";
import {
  WorkspaceOwnershipConflict,
  WorkspaceOwnershipRepository,
} from "../../persistence/Services/WorkspaceOwnership.ts";
import { WorkspaceOwnershipRepositoryLive } from "../../persistence/Layers/WorkspaceOwnership.ts";
import { ThreadUrlBuilder } from "../../threadUrl.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandWorktreeCleanupPendingError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { childReportDedupeKey } from "../dispatchAuthority.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import type { ProjectionReceipt } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<DispatchResult, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread" | "workflow";
  readonly aggregateId: ProjectId | ThreadId | WorkflowRunId;
} {
  switch (command.type) {
    case "project.create":
    case "chat-archive.import":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "workflow.run.request":
    case "workflow.node.worker.start":
    case "workflow.worker-result.record":
    case "workflow.run.finalize":
      return {
        aggregateKind: "workflow",
        aggregateId: command.runId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
  const threadUrls = yield* Effect.serviceOption(ThreadUrlBuilder);
  const coordinator = yield* CheckoutCoordinator;
  const workspaceOwnership = yield* WorkspaceOwnershipRepository;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const initialized = yield* Deferred.make<void, OrchestrationDispatchError>();
  const worktreeLock = yield* Semaphore.make(1);

  const withWorktreeLock: OrchestrationEngineShape["withWorktreeLock"] = (effect) =>
    worktreeLock.withPermits(1)(effect);

  const dispatchResult = (
    command: OrchestrationCommand,
    sequence: number,
    reportVerdict?: DispatchReportVerdict,
  ): DispatchResult => ({
    sequence,
    ...((command.type === "thread.create" ||
      (command.type === "thread.turn.start" && command.bootstrap?.createThread !== undefined)) &&
    Option.isSome(threadUrls)
      ? { threadUrl: threadUrls.value.forThread(command.threadId) }
      : {}),
    ...(reportVerdict !== undefined ? { reportVerdict } : {}),
  });

  // Recovers the fencing outcome of a child report from durable receipt
  // activities, so retried deliveries replay the recorded verdict instead
  // of re-mutating. Returns undefined when the command produced no report
  // receipt (e.g. pre-fence history or a different command type).
  const reportVerdictFromReceiptPayload = (payload: unknown): DispatchReportVerdict | undefined => {
    const verdict = (payload as { readonly dispatchVerdict?: unknown } | null | undefined)
      ?.dispatchVerdict;
    return verdict === "accepted" || verdict === "already-recorded" || verdict === "stale"
      ? verdict
      : undefined;
  };

  const reportVerdictFromActivity = (activity: {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly payload?: unknown;
  }): DispatchReportVerdict | undefined =>
    activity.kind === "delegation.reported"
      ? reportVerdictFromReceiptPayload(activity.payload)
      : undefined;

  const reportVerdictForCommand = (
    commandId: string,
    events: ReadonlyArray<{ readonly type: string; readonly payload?: unknown }>,
  ): DispatchReportVerdict | undefined => {
    for (const event of events) {
      if (event.type !== "thread.activity-appended") {
        continue;
      }
      const activity = (event.payload as { readonly activity?: unknown } | undefined)?.activity as
        | { readonly id?: unknown; readonly kind?: unknown; readonly payload?: unknown }
        | undefined;
      if (activity?.id !== commandId) {
        continue;
      }
      const verdict = activity ? reportVerdictFromActivity(activity) : undefined;
      if (verdict !== undefined) {
        return verdict;
      }
    }
    return undefined;
  };

  const reportVerdictFromActivities = (
    commandId: string,
    activities: ReadonlyArray<{
      readonly id?: unknown;
      readonly kind?: unknown;
      readonly payload?: unknown;
    }>,
  ): DispatchReportVerdict | undefined => {
    const activity = activities.find((entry) => entry.id === commandId);
    return activity ? reportVerdictFromActivity(activity) : undefined;
  };

  // Durable fallback when the receipt activity has aged out of the capped
  // read model: the event log retains every `thread.activity-appended` row
  // indexed by command ID, so a valid retry still recovers its verdict.
  const reportVerdictFromDurableEvents = (
    commandId: string,
  ): Effect.Effect<DispatchReportVerdict | undefined> =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json
      FROM orchestration_events
      WHERE command_id = ${commandId} AND event_type = 'thread.activity-appended'
      LIMIT 5
    `.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.reportVerdict:query")),
      Effect.map((rows) => {
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.payload_json) as unknown;
          } catch {
            continue;
          }
          const verdict = reportVerdictFromActivity(
            (parsed as { readonly activity?: unknown }).activity as {
              readonly id?: unknown;
              readonly kind?: unknown;
              readonly payload?: unknown;
            },
          );
          if (verdict !== undefined) {
            return verdict;
          }
        }
        return undefined;
      }),
      Effect.catch((error) =>
        Effect.logWarning("orchestration report verdict durable lookup failed", {
          commandId,
          error,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const reportIdentityForCommand = (
    command: Extract<OrchestrationCommand, { type: "thread.child.report" }>,
    model: OrchestrationReadModel,
  ) => {
    const delegation = model.threads.find((thread) => thread.id === command.threadId)?.nudging
      ?.delegation;
    const assignmentId = command.assignmentId ?? delegation?.assignmentId;
    if (!assignmentId) return null;
    return {
      reportKey: childReportDedupeKey({
        childThreadId: command.threadId,
        dispatchId: command.dispatchId,
        originTurnId: command.originTurnId,
        assignmentId,
        reportId: command.reportId,
      }),
      assignmentId,
    };
  };

  const findRecordedReportOutcome = (reportKey: string) =>
    sql<{ readonly outcome: string }>`
      SELECT outcome
      FROM delegation_report_receipts
      WHERE report_key = ${reportKey}
    `.pipe(
      Effect.map((rows) => {
        const outcome = rows[0]?.outcome;
        return outcome === "accepted" || outcome === "stale" ? outcome : undefined;
      }),
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.reportReceipt:query")),
    );

  const commandWorktreePath = (command: OrchestrationCommand): string | null => {
    switch (command.type) {
      case "thread.create":
        return command.worktreePath;
      case "thread.meta.update":
        return command.worktreePath ?? null;
      case "thread.workspace.handoff":
        return command.worktreePath;
      default:
        return null;
    }
  };

  const cleanupWorktreePath = (
    command: OrchestrationCommand,
    model: OrchestrationReadModel,
  ): string | null => {
    const directPath = commandWorktreePath(command);
    if (directPath !== null) {
      return directPath;
    }
    switch (command.type) {
      case "thread.unarchive":
      case "thread.queued-turn.create":
      case "thread.queued-turn.dispatch":
        return model.threads.find((thread) => thread.id === command.threadId)?.worktreePath ?? null;
      case "thread.turn.start":
        return (
          model.threads.find((thread) => thread.id === command.threadId)?.worktreePath ??
          command.bootstrap?.createThread?.worktreePath ??
          null
        );
      default:
        return null;
    }
  };

  const canonicalizeCommandWorktree = Effect.fn("canonicalizeCommandWorktree")(function* (
    command: OrchestrationCommand,
  ) {
    const worktreePath = commandWorktreePath(command);
    if (worktreePath === null) {
      return command;
    }
    const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
    switch (command.type) {
      case "thread.create":
      case "thread.meta.update":
      case "thread.workspace.handoff":
        return { ...command, worktreePath: canonicalPath };
      default:
        return command;
    }
  });

  const prepareIsolatedWorkspace = Effect.fn("prepareIsolatedWorkspace")(function* (
    command: OrchestrationCommand,
    projectWorkspaceRoot: string | undefined,
    thread: OrchestrationReadModel["threads"][number] | undefined,
  ) {
    const isExecutionCommand =
      command.type === "thread.create" ||
      command.type === "thread.turn.start" ||
      command.type === "thread.queued-turn.dispatch";
    const createThread =
      command.type === "thread.create"
        ? command
        : command.type === "thread.turn.start"
          ? command.bootstrap?.createThread
          : undefined;
    if (
      (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch") &&
      thread === undefined &&
      createThread === undefined
    ) {
      return { command, worktreePath: null, branch: null, honoredProjectCheckout: false };
    }
    const requestedPath =
      createThread?.worktreePath ??
      (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch"
        ? (thread?.workspaceBinding?.worktreePath ?? thread?.worktreePath)
        : command.type === "thread.workspace.handoff"
          ? command.worktreePath
          : command.type === "thread.meta.update"
            ? command.worktreePath
            : undefined);
    const projectRoot =
      projectWorkspaceRoot === undefined
        ? undefined
        : yield* Effect.promise(() => canonicalizeWorktreePath(projectWorkspaceRoot));
    const gitRoot =
      projectRoot === undefined
        ? null
        : yield* Effect.promise(() => resolveGitWorktreeRoot(projectRoot));

    const canonicalRequested =
      requestedPath === null || requestedPath === undefined
        ? null
        : yield* Effect.promise(() => canonicalizeWorktreePath(requestedPath));
    // An explicit project-checkout path in the current creation request (the
    // client sent a concrete directory instead of null) means the user chose
    // "Current checkout": honor it instead of allocating an isolated
    // worktree. Follow-up turns without a creation request are honored only
    // when the thread's persisted binding carries the project-checkout scope
    // recorded below; legacy root bindings without that scope keep isolating
    // so existing threads can never silently gain main-checkout writes.
    const isFreshCheckoutRequest = typeof createThread?.worktreePath === "string";
    const isPersistedCheckoutRequest =
      createThread === undefined &&
      (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch") &&
      thread?.workspaceBinding?.workspaceScope === "project-checkout";
    if (canonicalRequested !== null) {
      const requestedRoot = yield* Effect.promise(() => resolveGitWorktreeRoot(canonicalRequested));
      const isProjectCheckout =
        (requestedRoot !== null && requestedRoot === gitRoot) ||
        (requestedRoot === null && projectRoot === canonicalRequested);
      if (
        isProjectCheckout &&
        isExecutionCommand &&
        (isFreshCheckoutRequest || isPersistedCheckoutRequest)
      ) {
        return {
          command,
          worktreePath: canonicalRequested,
          branch: createThread?.branch ?? thread?.branch ?? null,
          honoredProjectCheckout: true,
        };
      }
      if (isProjectCheckout && isExecutionCommand && gitRoot !== null) {
        // Treat legacy/root bindings as an isolation request. This preserves
        // the user's turn and recovery path while ensuring the human checkout
        // is never admitted as the writer's workspace.
      } else if (isProjectCheckout) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The project checkout is reserved for the human. Choose or create an isolated worktree; T3 will not write the main checkout.",
        });
      } else {
        return {
          command,
          worktreePath: canonicalRequested,
          branch: createThread?.branch ?? null,
          honoredProjectCheckout: false,
        };
      }
    }

    if (!isExecutionCommand) {
      return {
        command,
        worktreePath: null,
        branch: null,
        honoredProjectCheckout: false,
      };
    }

    let threadId: string | undefined;
    switch (command.type) {
      case "thread.create":
      case "thread.turn.start":
      case "thread.queued-turn.dispatch":
        threadId = command.threadId;
        break;
    }
    if (threadId === undefined) {
      return { command, worktreePath: null, branch: null, honoredProjectCheckout: false };
    }
    if (gitRoot === null) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "This legacy or non-Git workspace has no durable isolated checkout. Choose an explicit exclusive directory and retry; T3 will not fall back to the project root.",
      });
    }
    const repositoryKey = createHash("sha256").update(gitRoot).digest("hex").slice(0, 16);
    const threadWorkspaceKey = createHash("sha256").update(threadId).digest("hex");
    const sourceBranch =
      createThread?.sourceBranch ?? createThread?.branch ?? thread?.branch ?? "HEAD";
    const branch = `t3/thread/${threadWorkspaceKey.slice(0, 24)}`;
    const worktreePath = path.join(
      path.dirname(gitRoot),
      ".t3-thread-workspaces",
      repositoryKey,
      threadWorkspaceKey,
    );
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(worktreePath), { recursive: true });
        const existing = await runProcess(
          "git",
          ["-C", worktreePath, "rev-parse", "--show-toplevel"],
          {
            allowNonZeroExit: true,
            maxBufferBytes: 16 * 1024,
            timeoutMs: 5_000,
          },
        );
        if (existing.code === 0) {
          const [existingCommonDir, expectedCommonDir, existingBranch] = await Promise.all([
            runProcess("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], {
              allowNonZeroExit: true,
              maxBufferBytes: 16 * 1024,
              timeoutMs: 5_000,
            }),
            runProcess("git", ["-C", gitRoot, "rev-parse", "--git-common-dir"], {
              allowNonZeroExit: false,
              maxBufferBytes: 16 * 1024,
              timeoutMs: 5_000,
            }),
            runProcess("git", ["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"], {
              allowNonZeroExit: true,
              maxBufferBytes: 16 * 1024,
              timeoutMs: 5_000,
            }),
          ]);
          if (existingCommonDir.code !== 0 || existingBranch.code !== 0) {
            throw new Error("existing workspace is not a checked-out Git worktree");
          }
          const canonicalCommonDir = await canonicalizeWorktreePath(
            path.resolve(worktreePath, existingCommonDir.stdout.trim()),
          );
          const canonicalExpectedCommonDir = await canonicalizeWorktreePath(
            path.resolve(gitRoot, expectedCommonDir.stdout.trim()),
          );
          if (
            canonicalCommonDir !== canonicalExpectedCommonDir ||
            existingBranch.stdout.trim() !== branch
          ) {
            throw new Error(
              `existing workspace belongs to common Git directory '${canonicalCommonDir}' and branch '${existingBranch.stdout.trim()}', expected '${canonicalExpectedCommonDir}' and '${branch}'`,
            );
          }
          return;
        }
        const sourceRevision =
          createThread?.sourceWorktreePath === undefined
            ? sourceBranch
            : (
                await runProcess(
                  "git",
                  ["-C", createThread.sourceWorktreePath, "rev-parse", "HEAD"],
                  {
                    allowNonZeroExit: true,
                    maxBufferBytes: 16 * 1024,
                    timeoutMs: 5_000,
                  },
                )
              ).stdout.trim();
        if (!sourceRevision) {
          throw new Error(
            `could not resolve source revision from '${createThread?.sourceWorktreePath ?? sourceBranch}'`,
          );
        }
        const existingBranch = await runProcess(
          "git",
          ["-C", gitRoot, "show-ref", "--verify", `refs/heads/${branch}`],
          {
            allowNonZeroExit: true,
            maxBufferBytes: 16 * 1024,
            timeoutMs: 5_000,
          },
        );
        const worktreeArguments =
          existingBranch.code === 0
            ? ["-C", gitRoot, "worktree", "add", worktreePath, branch]
            : ["-C", gitRoot, "worktree", "add", "-b", branch, worktreePath, sourceRevision];
        const result = await runProcess("git", worktreeArguments, {
          allowNonZeroExit: true,
          maxBufferBytes: 64 * 1024,
          timeoutMs: 30_000,
        });
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() || `git worktree add failed with code ${result.code}`,
          );
        }
      },
      catch: (cause) =>
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Unable to allocate isolated workspace '${worktreePath}' for thread '${threadId}': ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const nextCommand =
      command.type === "thread.create"
        ? { ...command, branch, worktreePath }
        : command.type === "thread.turn.start" && command.bootstrap?.createThread
          ? {
              ...command,
              bootstrap: {
                ...command.bootstrap,
                createThread: { ...command.bootstrap.createThread, branch, worktreePath },
              },
            }
          : command.type === "thread.queued-turn.dispatch"
            ? { ...command, workspaceBinding: undefined }
            : command;
    return { command: nextCommand, worktreePath, branch, honoredProjectCheckout: false };
  });

  const admitWorkspace = Effect.fn("admitWorkspace")(function* (command: OrchestrationCommand) {
    let thread: OrchestrationReadModel["threads"][number] | undefined;
    switch (command.type) {
      case "thread.create":
      case "thread.turn.start":
      case "thread.workspace.handoff":
      case "thread.meta.update":
      case "thread.delete":
      case "thread.queued-turn.dispatch":
        thread = readModel.threads.find(
          (entry) => entry.id === (command as { readonly threadId: string }).threadId,
        );
        break;
    }
    const projectId =
      thread?.projectId ??
      (command.type === "thread.create" ? command.projectId : undefined) ??
      (command.type === "thread.turn.start"
        ? command.bootstrap?.createThread?.projectId
        : undefined);
    const project =
      projectId === undefined
        ? undefined
        : readModel.projects.find((entry) => entry.id === projectId);
    const prepared = yield* prepareIsolatedWorkspace(command, project?.workspaceRoot, thread);
    command = prepared.command;
    const requestedPath =
      command.type === "thread.create"
        ? (command.worktreePath ?? project?.workspaceRoot)
        : command.type === "thread.workspace.handoff"
          ? command.worktreePath
          : command.type === "thread.queued-turn.dispatch"
            ? (command.workspaceBinding?.worktreePath ??
              prepared.worktreePath ??
              thread?.workspaceBinding?.worktreePath ??
              thread?.worktreePath ??
              project?.workspaceRoot)
            : command.type === "thread.meta.update"
              ? command.worktreePath
              : ((command.type === "thread.turn.start"
                  ? command.bootstrap?.createThread?.worktreePath
                  : undefined) ??
                prepared.worktreePath ??
                thread?.workspaceBinding?.worktreePath ??
                thread?.worktreePath ??
                project?.workspaceRoot);
    if (
      requestedPath === undefined ||
      requestedPath === null ||
      !("threadId" in command) ||
      command.type === "thread.delete" ||
      command.type === "thread.archive"
    ) {
      return command;
    }
    const binding = yield* workspaceOwnership
      .claim({
        threadId: command.threadId,
        worktreePath: requestedPath,
        branch:
          command.type === "thread.create"
            ? command.branch
            : command.type === "thread.workspace.handoff"
              ? command.branch
              : (prepared.branch ?? thread?.workspaceBinding?.branch ?? thread?.branch ?? null),
        commandId: command.commandId,
        now: new Date().toISOString(),
      })
      .pipe(
        Effect.mapError((error) => {
          if (error instanceof WorkspaceOwnershipConflict) {
            return new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Workspace '${error.canonicalPath}' is owned by thread '${error.ownerThreadId}'. Stop that writer or use a different worktree; no edits were stashed or moved.`,
            });
          }
          return new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workspace admission failed for '${requestedPath}'. Recover the existing owner before retrying.`,
          });
        }),
      );
    const withBinding = {
      ...command,
      workspaceBinding: prepared.honoredProjectCheckout
        ? { ...binding, workspaceScope: "project-checkout" as const }
        : binding,
    } as OrchestrationCommand;
    return withBinding;
  });

  const isWorktreeCleanupPending = Effect.fn("isWorktreeCleanupPending")(function* (
    worktreePath: string,
  ) {
    const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
    return yield* worktreeCleanupJobs.hasReservationByPath(canonicalPath);
  });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });
    // Canonical path admitted by this dispatch attempt (the Git top-level
    // ownership key). Recorded for failure compensation below: recomputing it
    // from the command input would miss the claimed row when a handoff
    // targets a subdirectory of the worktree.
    let admittedCanonicalPath: string | undefined;

    const process = Effect.exit(
      Effect.gen(function* () {
        const command = yield* canonicalizeCommandWorktree(envelope.command);
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            // Durable verdict replay: a retried report returns its recorded
            // outcome without re-mutating. The in-memory read model caps
            // activities (projector retains 500), so fall back to the durable
            // event log by command ID when the receipt activity has aged out.
            const completedCommand = envelope.command;
            const replayedVerdict =
              completedCommand.type === "thread.child.report"
                ? (reportVerdictFromActivities(
                    completedCommand.commandId,
                    readModel.threads.find((thread) => thread.id === completedCommand.threadId)
                      ?.activities ?? [],
                  ) ?? (yield* reportVerdictFromDurableEvents(completedCommand.commandId)))
                : undefined;
            return dispatchResult(command, existingReceipt.value.resultSequence, replayedVerdict);
          }

          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const previousWorkspaceBinding =
          command.type === "thread.workspace.handoff"
            ? readModel.threads.find((thread) => thread.id === command.threadId)?.workspaceBinding
            : undefined;
        const admittedCommand = yield* admitWorkspace(command);
        admittedCanonicalPath =
          "workspaceBinding" in admittedCommand
            ? admittedCommand.workspaceBinding?.canonicalPath
            : undefined;
        const worktreePath = cleanupWorktreePath(admittedCommand, readModel);
        if (worktreePath !== null && (yield* isWorktreeCleanupPending(worktreePath))) {
          return yield* new OrchestrationCommandWorktreeCleanupPendingError({
            commandType: command.type,
            worktreePath,
          });
        }

        if (command.type === "thread.queued-turn.dispatch") {
          const queued = readModel.threads
            .find((thread) => thread.id === command.threadId)
            ?.queuedTurns?.find((turn) => turn.id === command.queuedTurnId);
          if (queued?.origin?.kind === "child-nudge") {
            const pending = yield* sql<{ readonly pending: number }>`
              SELECT pending_approval_count + pending_user_input_count AS pending
              FROM projection_threads WHERE thread_id = ${command.threadId}
            `;
            if (pending[0]?.pending) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Child follow-up is awaiting approval or input.",
              });
            }
          }
        }

        const reportIdentity =
          command.type === "thread.child.report"
            ? reportIdentityForCommand(command, readModel)
            : null;
        const recordedReportOutcome =
          reportIdentity === null
            ? undefined
            : yield* findRecordedReportOutcome(reportIdentity.reportKey);
        const eventBase = yield* decideOrchestrationCommand({
          command: admittedCommand,
          readModel,
          ...(recordedReportOutcome !== undefined ? { recordedReportOutcome } : {}),
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        // A failed metadata precondition is an accepted no-op. Persist its
        // receipt so retrying the same command cannot apply it to a later state.
        if (
          eventBases.length === 0 &&
          admittedCommand.type === "thread.meta.update" &&
          (admittedCommand.expectedUpdatedAt !== undefined ||
            admittedCommand.expectedWorkspaceCwd !== undefined)
        ) {
          yield* commandReceiptRepository.upsert({
            commandId: command.commandId,
            aggregateKind: aggregateRef.aggregateKind,
            aggregateId: aggregateRef.aggregateId,
            acceptedAt: new Date().toISOString(),
            resultSequence: readModel.snapshotSequence,
            status: "accepted",
            error: null,
          });
          return dispatchResult(command, readModel.snapshotSequence);
        }
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const projectionReceipts: ProjectionReceipt[] = [];
              let nextReadModel = readModel;
              const skippedEventIds = new Set<string>();

              for (const nextEvent of eventBases) {
                if (
                  nextEvent.causationEventId !== null &&
                  skippedEventIds.has(nextEvent.causationEventId)
                ) {
                  skippedEventIds.add(nextEvent.eventId);
                  continue;
                }
                if (nextEvent.type === "thread.child-lifecycle-notified") {
                  const claimed = yield* sql<{ readonly dedupe_key: string }>`
                    INSERT INTO child_lifecycle_notification_dedup (
                      dedupe_key,
                      event_id,
                      created_at
                    )
                    VALUES (
                      ${nextEvent.payload.dedupeKey},
                      ${nextEvent.eventId},
                      ${nextEvent.occurredAt}
                    )
                    ON CONFLICT(dedupe_key) DO NOTHING
                    RETURNING dedupe_key
                  `;
                  if (claimed.length === 0) {
                    skippedEventIds.add(nextEvent.eventId);
                    continue;
                  }
                }
                const savedEvent = yield* eventStore.append(nextEvent);
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                projectionReceipts.push(yield* projectionPipeline.projectEvent(savedEvent));
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              if (command.type === "thread.child.report" && reportIdentity !== null) {
                const outcome = reportVerdictForCommand(command.commandId, committedEvents);
                if (outcome === "accepted" || outcome === "stale") {
                  yield* sql`
                    INSERT INTO delegation_report_receipts (
                      report_key,
                      command_id,
                      child_thread_id,
                      assignment_id,
                      dispatch_id,
                      origin_turn_id,
                      report_id,
                      outcome,
                      created_at
                    )
                    VALUES (
                      ${reportIdentity.reportKey},
                      ${command.commandId},
                      ${command.threadId},
                      ${reportIdentity.assignmentId},
                      ${command.dispatchId ?? null},
                      ${command.originTurnId ?? null},
                      ${command.reportId},
                      ${outcome},
                      ${command.createdAt}
                    )
                    ON CONFLICT(report_key) DO NOTHING
                  `;
                }
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
                projectionReceipts,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        readModel = committedCommand.nextReadModel;
        if (
          admittedCommand.type === "thread.workspace.handoff" &&
          previousWorkspaceBinding !== undefined &&
          admittedCommand.workspaceBinding !== undefined &&
          previousWorkspaceBinding.canonicalPath !== admittedCommand.workspaceBinding.canonicalPath
        ) {
          yield* workspaceOwnership
            .release(admittedCommand.threadId, previousWorkspaceBinding.canonicalPath)
            .pipe(
              Effect.catch((error) =>
                Effect.logError("workspace handoff committed but old ownership remains held", {
                  threadId: admittedCommand.threadId,
                  canonicalPath: previousWorkspaceBinding.canonicalPath,
                  error,
                }),
              ),
            );
        }
        yield* Effect.forEach(committedCommand.projectionReceipts, (receipt) => receipt.reconcile, {
          concurrency: 1,
          discard: true,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("projection post-commit reconciliation remains pending", {
              commandId: envelope.command.commandId,
              error,
            }),
          ),
          Effect.ignore,
        );
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return dispatchResult(
          admittedCommand,
          committedCommand.lastSequence,
          command.type === "thread.child.report"
            ? reportVerdictForCommand(command.commandId, committedCommand.committedEvents)
            : undefined,
        );
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            const releaseFailedAdmission = Effect.gen(function* () {
              const failedThreadId = (() => {
                switch (envelope.command.type) {
                  case "thread.create":
                    return envelope.command.threadId;
                  case "thread.turn.start":
                    return envelope.command.bootstrap?.createThread === undefined
                      ? undefined
                      : envelope.command.threadId;
                  default:
                    return undefined;
                }
              })();
              if (
                failedThreadId !== undefined &&
                !readModel.threads.some((thread) => thread.id === failedThreadId)
              ) {
                yield* workspaceOwnership.release(failedThreadId);
              }

              const transferCommand =
                envelope.command.type === "thread.workspace.handoff" ||
                envelope.command.type === "thread.meta.update"
                  ? envelope.command
                  : undefined;
              if (transferCommand !== undefined && admittedCanonicalPath !== undefined) {
                const currentThread = readModel.threads.find(
                  (thread) => thread.id === transferCommand.threadId,
                );
                if (admittedCanonicalPath !== currentThread?.workspaceBinding?.canonicalPath) {
                  yield* workspaceOwnership.release(
                    transferCommand.threadId,
                    admittedCanonicalPath,
                  );
                }
              }
            }).pipe(
              Effect.catch((cleanupError) =>
                Effect.logWarning("failed to compensate workspace admission", {
                  commandId: envelope.command.commandId,
                  cleanupError,
                }),
              ),
            );
            yield* releaseFailedAdmission;
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: readModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
    const command = envelope.command;
    const cleanupPath = cleanupWorktreePath(command, readModel);
    const requiresWorktreeLock =
      cleanupPath !== null ||
      command.type === "thread.archive" ||
      command.type === "thread.unarchive" ||
      command.type === "thread.delete";
    const worktreeProcess = requiresWorktreeLock ? withWorktreeLock(process) : process;
    if (command.type !== "thread.turn.start" && command.type !== "thread.queued-turn.dispatch") {
      return worktreeProcess;
    }
    const thread = readModel.threads.find((entry) => entry.id === command.threadId);
    const bootstrap = command.type === "thread.turn.start" ? command.bootstrap : undefined;
    const projectId = thread?.projectId ?? bootstrap?.createThread?.projectId;
    const project = readModel.projects.find((entry) => entry.id === projectId);
    const cwd =
      thread?.worktreePath ?? bootstrap?.createThread?.worktreePath ?? project?.workspaceRoot;
    // This is the command worker itself, not dispatch(). Release after the
    // committed pending state is visible, before the provider starts its turn.
    return cwd ? coordinator.withCheckout(cwd, worktreeProcess) : worktreeProcess;
  };

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const initializationExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* projectionPipeline.bootstrap;
          readModel = yield* projectionSnapshotQuery.getSnapshot();
          yield* Effect.forkScoped(worker);
          yield* Effect.logDebug("orchestration engine started").pipe(
            Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
          );
        }),
      );
      if (Exit.isFailure(initializationExit)) {
        yield* Deferred.failCause(initialized, initializationExit.cause).pipe(Effect.orDie);
        return;
      }
      yield* Deferred.succeed(initialized, undefined).pipe(Effect.orDie);
    }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Deferred.await(initialized).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error("Orchestration engine initialization failed"),
      ),
      Effect.orDie,
      Effect.map(() => readModel),
    );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Deferred.await(initialized);
      const result = yield* Deferred.make<DispatchResult, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    readEvents,
    dispatch,
    withWorktreeLock,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // Scoped subscribe registers the subscription synchronously during the yield,
    // giving consumers an explicit attach-before-snapshot handshake.
    acquireDomainEventSubscription: PubSub.subscribe(eventPubSub),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
  Layer.provideMerge(CheckoutCoordinatorLive),
  Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
);
