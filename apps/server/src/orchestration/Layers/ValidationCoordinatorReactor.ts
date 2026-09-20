import {
  CommandId,
  isValidationRunTerminal,
  type OrchestrationEvent,
  type ThreadId,
  type ValidationRequest,
  type ValidationRun,
  type ValidationTarget,
  validationRunEffectiveStatus,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ValidationCoordinatorReactor,
  ValidationCoordinatorTargetResolver,
  type ValidationCoordinatorReactorShape,
  type ValidationCoordinatorRequest,
} from "../Services/ValidationCoordinatorReactor.ts";
import {
  collectChangedPathsFromCheckpoints,
  planCoordinatorRunWithPolicy,
  selectNextRunnableGate,
} from "../../validation/ValidationPlanner.ts";
import {
  isBrowserGateKind,
  isRepositoryGateKind,
  ValidationGateExecutor,
} from "../../validation/ValidationGateExecutor.ts";

const commandId = (runId: string, action: string): CommandId =>
  CommandId.make(`validation:${runId}:${action}`);

const runIdForRequest = (requestId: string): string => `validation:${requestId}`;
const executorIdForTarget = (target: ValidationTarget): string =>
  `validation-coordinator:${target.environmentIdentity}`;
export const isValidationCoordinatorOwnedRun = (run: ValidationRun): boolean =>
  run.requestId !== undefined;

const isValidationEvent = (event: OrchestrationEvent): boolean =>
  event.type.startsWith("thread.validation-");

const makeTargetResolver = Effect.gen(function* () {
  const git = yield* GitCore;
  const environment = yield* ServerEnvironment;
  const orchestrationEngine = yield* OrchestrationEngineService;

  return {
    resolve: (threadId: ThreadId) =>
      Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === threadId);
        if (!thread) {
          return yield* Effect.fail(new Error(`Validation thread ${threadId} does not exist.`));
        }
        const project = readModel.projects.find((entry) => entry.id === thread.projectId);
        if (!project) {
          return yield* Effect.fail(
            new Error(`Validation project for thread ${threadId} does not exist.`),
          );
        }
        const cwd =
          thread.workspaceBinding?.worktreePath ?? thread.worktreePath ?? project.workspaceRoot;
        const status = yield* git.statusDetailsLocal(cwd);
        if (!status.isRepo || !status.revision || !status.dirtyStateFingerprint) {
          return yield* Effect.fail(new Error(`Validation target is unavailable for ${cwd}.`));
        }
        return {
          workspaceRoot: project.workspaceRoot,
          worktreePath: cwd,
          branch: status.branch ?? thread.workspaceBinding?.branch ?? thread.branch,
          revision: status.revision,
          dirtyStateFingerprint: status.dirtyStateFingerprint,
          environmentIdentity: yield* environment.getEnvironmentId,
        } satisfies ValidationTarget;
      }),
  };
});

const makeValidationCoordinatorReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const targetResolver = yield* ValidationCoordinatorTargetResolver;
  const gateExecutor = yield* ValidationGateExecutor;
  let reconciling = false;
  let queued = false;

  const planRequest = Effect.fn("ValidationCoordinatorReactor.planRequest")(function* (
    request: ValidationRequest,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === request.threadId);
    if (
      !thread ||
      (thread.validationRun !== null &&
        thread.validationRun !== undefined &&
        !isValidationRunTerminal(validationRunEffectiveStatus(thread.validationRun)))
    ) {
      return;
    }
    const target = yield* targetResolver.resolve(request.threadId).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.validation.request-failed",
            commandId: commandId(runIdForRequest(request.requestId), "request-failed"),
            threadId: request.threadId,
            failure: {
              requestId: request.requestId,
              reason: error.message,
              failedAt: new Date().toISOString(),
            },
          });
          return yield* Effect.fail(error);
        }),
      ),
    );
    const changedPaths = collectChangedPathsFromCheckpoints(thread.checkpoints ?? []);
    const runId = runIdForRequest(request.requestId);
    yield* orchestrationEngine.dispatch({
      type: "thread.validation.coordinator-plan",
      commandId: commandId(runId, "plan"),
      threadId: request.threadId,
      run: planCoordinatorRunWithPolicy({
        id: runId,
        requestId: request.requestId,
        threadId: request.threadId,
        target,
        scenarios: request.scenarios,
        scope: request.scope,
        requester: request.requester,
        requestedAt: request.requestedAt,
        changedPaths,
      }),
      createdAt: request.requestedAt,
    });
  });

  const releaseLease = Effect.fn("ValidationCoordinatorReactor.releaseLease")(function* (
    run: NonNullable<import("@t3tools/contracts").OrchestrationThread["validationRun"]>,
  ) {
    if (!run.lease) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.validation.lease.release",
      commandId: commandId(run.id, `release:${run.lease.id}`),
      threadId: run.threadId,
      runId: run.id,
      leaseId: run.lease.id,
      releasedAt: new Date().toISOString(),
    });
  });

  const reconcileRun = Effect.fn("ValidationCoordinatorReactor.reconcileRun")(function* (
    runId: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.validationRun?.id === runId);
    const run = thread?.validationRun;
    if (!thread || !run || !isValidationCoordinatorOwnedRun(run)) return;
    const status = validationRunEffectiveStatus(run);
    if (status === "interrupted") {
      yield* releaseLease(run);
      const resumedAt = new Date().toISOString();
      const resetExecutorId = run.executorId;
      if (resetExecutorId) {
        for (const gate of run.gates) {
          if (gate.status !== "interrupted") continue;
          yield* orchestrationEngine.dispatch({
            type: "thread.validation-gate.update",
            commandId: commandId(run.id, `reset:${gate.id}:${run.updatedAt}`),
            threadId: thread.id,
            runId: run.id,
            executorId: resetExecutorId,
            target: run.target,
            gateId: gate.id,
            status: "pending",
            command: gate.command,
            startedAt: null,
            completedAt: null,
            exitCode: null,
            outputRef: null,
            blockerReason: null,
            diagnostics: [
              ...gate.diagnostics,
              "Gate reset to pending after the run was interrupted.",
            ],
            createdAt: resumedAt,
          });
        }
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, `resume-planned:${run.updatedAt}`),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "planned",
          reason: null,
          updatedAt: resumedAt,
        },
      });
      return;
    }
    if (isValidationRunTerminal(status)) {
      yield* releaseLease(run);
      return;
    }
    if (run.lease && Date.parse(run.lease.expiresAt) <= Date.now()) {
      yield* releaseLease(run);
      return;
    }

    const currentTarget = yield* targetResolver.resolve(thread.id).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (status === "planned" || status === "preparing" || status === "running") {
            yield* orchestrationEngine.dispatch({
              type: "thread.validation.lifecycle",
              commandId: commandId(run.id, "blocked-target"),
              threadId: thread.id,
              update: {
                runId: run.id,
                status: "blocked",
                reason: error.message,
                updatedAt: new Date().toISOString(),
              },
            });
            yield* releaseLease(run);
            return null;
          }
          return null;
        }),
      ),
    );
    if (currentTarget === null) return;
    if (
      currentTarget.revision !== run.target.revision ||
      currentTarget.dirtyStateFingerprint !== run.target.dirtyStateFingerprint ||
      currentTarget.branch !== run.target.branch ||
      currentTarget.worktreePath !== run.target.worktreePath ||
      currentTarget.workspaceRoot !== run.target.workspaceRoot ||
      currentTarget.environmentIdentity !== run.target.environmentIdentity
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "stale"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "stale",
          reason: "Validation target drifted after planning.",
          updatedAt: new Date().toISOString(),
        },
      });
      yield* releaseLease(run);
      return;
    }

    const executorId = executorIdForTarget(run.target);
    if (run.lease === null) {
      if (status === "planned") {
        yield* orchestrationEngine.dispatch({
          type: "thread.validation.lifecycle",
          commandId: commandId(run.id, "preparing"),
          threadId: thread.id,
          update: {
            runId: run.id,
            status: "preparing",
            reason: null,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      const claimedAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lease.claim",
        commandId: commandId(run.id, `claim:${run.updatedAt}`),
        threadId: thread.id,
        runId: run.id,
        executorId,
        target: run.target,
        lease: {
          id: `lease:${run.id}:${run.updatedAt}`,
          executorId,
          claimedAt,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        claimedAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "running"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "running",
          reason: null,
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (status === "planned") {
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "running-resumed"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "running",
          reason: null,
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (status !== "running") return;

    const runningGate = run.gates.find((gate) => gate.status === "running");
    if (runningGate) {
      const now = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.validation-gate.update",
        commandId: commandId(run.id, `interrupt:${runningGate.id}:${now}`),
        threadId: thread.id,
        runId: run.id,
        executorId: run.lease.executorId,
        target: run.target,
        gateId: runningGate.id,
        status: "interrupted",
        command: runningGate.command,
        startedAt: runningGate.startedAt,
        completedAt: now,
        exitCode: null,
        outputRef: runningGate.outputRef,
        blockerReason: null,
        diagnostics: [...runningGate.diagnostics, "Reactor restarted while gate was running."],
        createdAt: now,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "interrupted-restart"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "interrupted",
          reason: "Reactor restarted during gate execution.",
          updatedAt: now,
        },
      });
      return;
    }

    if (
      run.gates.every(
        (gate) => !gate.required || gate.status === "passed" || gate.status === "not-required",
      )
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "ready"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "ready",
          reason: null,
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    const nextGate = selectNextRunnableGate(run.gates);
    if (!nextGate) return;

    const observedAt = new Date().toISOString();
    const attemptId = `attempt:${run.id}:${nextGate.id}:${nextGate.attempts.length + 1}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.validation-gate.update",
      commandId: commandId(run.id, `start:${nextGate.id}:${attemptId}`),
      threadId: thread.id,
      runId: run.id,
      executorId: run.lease.executorId,
      target: run.target,
      gateId: nextGate.id,
      status: "running",
      command: nextGate.command,
      startedAt: observedAt,
      completedAt: null,
      exitCode: null,
      outputRef: null,
      blockerReason: null,
      diagnostics: [],
      createdAt: observedAt,
    });

    const cwd = run.target.worktreePath ?? run.target.workspaceRoot;
    if (isRepositoryGateKind(nextGate.kind)) {
      const result = yield* gateExecutor
        .executeRepositoryGate({
          runId: run.id,
          gate: { ...nextGate, status: "running", startedAt: observedAt },
          attemptId,
          leaseId: run.lease.id,
          executorId: run.lease.executorId,
          target: run.target,
          cwd,
          observedAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              id: `result:${run.id}:${nextGate.id}:${attemptId}`,
              runId: run.id,
              gateId: nextGate.id,
              attemptId,
              leaseId: run.lease?.id ?? `lease:${run.id}`,
              executorId: run.lease?.executorId ?? executorId,
              target: run.target,
              status: "blocked" as const,
              observedAt,
              completedAt: new Date().toISOString(),
              exitCode: null,
              outputRef: null,
              blockerReason:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : "Repository gate is blocked.",
              diagnostics: [error instanceof Error ? error.message.slice(0, 1000) : "Blocked."],
            }),
          ),
        );
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.result.record",
        commandId: commandId(run.id, `result:${nextGate.id}:${attemptId}`),
        threadId: thread.id,
        result,
      });
      return;
    }

    if (isBrowserGateKind(nextGate.kind)) {
      const scenarioId = nextGate.id.includes(":browser-scenario:")
        ? (nextGate.id.split(":browser-scenario:")[1] ?? nextGate.id)
        : "browser-validation";
      const result = yield* gateExecutor
        .executeBrowserGate({
          runId: run.id,
          gate: { ...nextGate, status: "running", startedAt: observedAt },
          scenarioId,
          attemptId,
          leaseId: run.lease.id,
          executorId: run.lease.executorId,
          target: run.target,
          threadId: run.threadId,
          observedAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              id: `result:${run.id}:${nextGate.id}:${attemptId}`,
              runId: run.id,
              gateId: nextGate.id,
              attemptId,
              leaseId: run.lease?.id ?? `lease:${run.id}`,
              executorId: run.lease?.executorId ?? executorId,
              target: run.target,
              status: "blocked" as const,
              observedAt,
              completedAt: new Date().toISOString(),
              exitCode: null,
              outputRef: null,
              blockerReason:
                error instanceof Error ? error.message.slice(0, 500) : "Browser gate is blocked.",
              diagnostics: [error instanceof Error ? error.message.slice(0, 1000) : "Blocked."],
            }),
          ),
        );
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.result.record",
        commandId: commandId(run.id, `result:${nextGate.id}:${attemptId}`),
        threadId: thread.id,
        result,
      });
      return;
    }

    const now = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.validation.result.record",
      commandId: commandId(run.id, `result:${nextGate.id}:${attemptId}`),
      threadId: thread.id,
      result: {
        id: `result:${run.id}:${nextGate.id}:${attemptId}`,
        runId: run.id,
        gateId: nextGate.id,
        attemptId,
        leaseId: run.lease.id,
        executorId: run.lease.executorId,
        target: run.target,
        status: "blocked" as const,
        observedAt,
        completedAt: now,
        exitCode: null,
        outputRef: null,
        blockerReason: `Gate kind ${nextGate.kind ?? "unknown"} has no integrated runner.`,
        diagnostics: ["Select a supported validation gate."],
      },
    });
  });

  const reconcileRequest = Effect.fn("ValidationCoordinatorReactor.reconcileRequest")(function* (
    request: ValidationRequest,
  ) {
    yield* planRequest(request);
    const runId = runIdForRequest(request.requestId);
    yield* reconcileRun(runId);
  });

  const reconcileSafely = (effect: Effect.Effect<void, unknown>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("validation coordinator reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reconcileAll = Effect.fn("ValidationCoordinatorReactor.reconcileAll")(function* () {
    if (reconciling) {
      queued = true;
      return;
    }
    reconciling = true;
    try {
      do {
        queued = false;
        const readModel = yield* orchestrationEngine.getReadModel();
        yield* Effect.forEach(
          readModel.threads.flatMap((thread) =>
            thread.validationRequest ? [thread.validationRequest] : [],
          ),
          reconcileRequest,
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          readModel.threads.flatMap((thread) =>
            thread.validationRun && isValidationCoordinatorOwnedRun(thread.validationRun)
              ? [thread.validationRun.id]
              : [],
          ),
          reconcileRun,
          { concurrency: 1 },
        );
      } while (queued);
    } finally {
      reconciling = false;
    }
  });

  const request: ValidationCoordinatorReactorShape["request"] = (
    input: ValidationCoordinatorRequest,
  ) =>
    Effect.gen(function* () {
      const requestId = crypto.randomUUID();
      const requestedAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.request",
        commandId: CommandId.make(requestId),
        threadId: input.threadId,
        scenarios: input.scenarios,
        scope: input.scope,
        requester: input.requester,
        requestedAt,
      });
      yield* reconcileRequest({
        requestId,
        threadId: input.threadId,
        scenarios: input.scenarios,
        scope: input.scope,
        requester: input.requester,
        requestedAt,
      });
      return { runId: runIdForRequest(requestId) };
    });

  const start: ValidationCoordinatorReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.validation-requested") {
          return reconcileSafely(reconcileRequest(event.payload.request));
        }
        return isValidationEvent(event) ? reconcileSafely(reconcileAll()) : Effect.void;
      }),
    );
    yield* reconcileSafely(reconcileAll());
  });

  return {
    request,
    reconcile: (runId) => reconcileSafely(reconcileRun(runId)),
    start,
  } satisfies ValidationCoordinatorReactorShape;
});

export const ValidationCoordinatorTargetResolverLive = Layer.effect(
  ValidationCoordinatorTargetResolver,
  makeTargetResolver,
);

export const ValidationCoordinatorReactorLive = Layer.effect(
  ValidationCoordinatorReactor,
  makeValidationCoordinatorReactor,
);
