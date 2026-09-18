import {
  CommandId,
  planValidationCoordinatorRun,
  type OrchestrationEvent,
  type ThreadId,
  type ValidationRequest,
  type ValidationTarget,
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

const commandId = (runId: string, action: string): CommandId =>
  CommandId.make(`validation:${runId}:${action}`);

const runIdForRequest = (requestId: string): string => `validation:${requestId}`;
const executorIdForTarget = (target: ValidationTarget): string =>
  `validation-coordinator:${target.environmentIdentity}`;

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
  let reconciling = false;
  let queued = false;

  const planRequest = Effect.fn("ValidationCoordinatorReactor.planRequest")(function* (
    request: ValidationRequest,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === request.threadId);
    if (!thread || (thread.validationRun !== null && thread.validationRun !== undefined)) {
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
    const runId = runIdForRequest(request.requestId);
    yield* orchestrationEngine.dispatch({
      type: "thread.validation.coordinator-plan",
      commandId: commandId(runId, "plan"),
      threadId: request.threadId,
      run: planValidationCoordinatorRun({
        id: runId,
        requestId: request.requestId,
        threadId: request.threadId,
        target,
        scenarios: request.scenarios,
        scope: request.scope,
        requester: request.requester,
        requestedAt: request.requestedAt,
      }),
      createdAt: request.requestedAt,
    });
  });

  const blockUnavailableGates = Effect.fn("ValidationCoordinatorReactor.blockUnavailableGates")(
    function* (
      run: NonNullable<import("@t3tools/contracts").OrchestrationThread["validationRun"]>,
    ) {
      const executorId = run.executorId;
      if (!executorId) return;
      const now = new Date().toISOString();
      for (const gate of run.gates) {
        if (!gate.required || gate.status !== "pending") continue;
        yield* orchestrationEngine.dispatch({
          type: "thread.validation-gate.update",
          commandId: commandId(run.id, `block:${gate.id}`),
          threadId: run.threadId,
          runId: run.id,
          executorId,
          target: run.target,
          gateId: gate.id,
          status: "blocked",
          command: gate.command,
          startedAt: null,
          completedAt: now,
          exitCode: null,
          outputRef: null,
          blockerReason: "Validation runner is not available yet.",
          diagnostics: ["This gate is blocked until its typed runner is integrated."],
          createdAt: now,
        });
      }
    },
  );

  const reconcileRun = Effect.fn("ValidationCoordinatorReactor.reconcileRun")(function* (
    runId: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.validationRun?.id === runId);
    const run = thread?.validationRun;
    if (!thread || !run || run.status === "stale" || run.status === "ready") return;

    const currentTarget = yield* targetResolver.resolve(thread.id).pipe(
      Effect.catch((error) => {
        const status = run.status ?? "planned";
        if (status === "planned" || status === "preparing" || status === "running") {
          return orchestrationEngine
            .dispatch({
              type: "thread.validation.lifecycle",
              commandId: commandId(run.id, "blocked-target"),
              threadId: thread.id,
              update: {
                runId: run.id,
                status: "blocked",
                reason: error.message,
                updatedAt: new Date().toISOString(),
              },
            })
            .pipe(Effect.as(null));
        }
        return Effect.succeed(null);
      }),
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
      return;
    }

    const executorId = executorIdForTarget(run.target);
    if (run.lease === null) {
      if ((run.status ?? "planned") === "planned") {
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
        commandId: commandId(run.id, "claim"),
        threadId: thread.id,
        runId: run.id,
        executorId,
        target: run.target,
        lease: {
          id: `lease:${run.id}`,
          executorId,
          claimedAt,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

    if ((run.status ?? "planned") === "running") {
      yield* blockUnavailableGates({ ...run, executorId });
      yield* orchestrationEngine.dispatch({
        type: "thread.validation.lifecycle",
        commandId: commandId(run.id, "blocked-runners"),
        threadId: thread.id,
        update: {
          runId: run.id,
          status: "blocked",
          reason: "Validation runners are not integrated.",
          updatedAt: new Date().toISOString(),
        },
      });
    }
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
            thread.validationRun ? [thread.validationRun.id] : [],
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
