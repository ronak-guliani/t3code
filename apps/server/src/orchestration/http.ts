import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { requireSessionScope, respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { canonicalizeWorktreePath } from "../git/worktreePaths.ts";
import { WorktreeCleanupJobRepository } from "../persistence/Services/WorktreeCleanupJobs.ts";
import { projectReadModel, projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { makeClientCommandDispatcher } from "./clientCommandDispatcher.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const isDefinitiveCommandRejection = (error: OrchestrationDispatchCommandError): boolean => {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return false;
  }
  return (
    cause._tag === "OrchestrationCommandInvariantError" ||
    cause._tag === "OrchestrationCommandPreviouslyRejectedError"
  );
};

const respondToOrchestrationHttpError = (
  error: OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
) =>
  Effect.gen(function* () {
    if (error._tag === "OrchestrationGetSnapshotError") {
      yield* Effect.logError("orchestration http route failed", {
        message: error.message,
        cause: error.cause,
      });
      return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
    }

    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
        code: isDefinitiveCommandRejection(error) ? "command-rejected" : "dispatch-failed",
      },
      { status: 400 },
    );
  });

const authorizeClientSession = (
  requiredScope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    yield* requireSessionScope(session.role, requiredScope, session.scopes);
    return session;
  });

export const orchestrationSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/snapshot",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationReadScope);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(
      projectReadModel(snapshot satisfies OrchestrationReadModel),
      {
        status: 200,
      },
    );
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
    }),
  ),
);

export const orchestrationShellSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/shell-snapshot",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationReadScope);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration shell snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationShellSnapshot, {
      status: 200,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
    }),
  ),
);

export const orchestrationArchivedShellSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/archived-shell-snapshot",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationReadScope);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* (
      projectionSnapshotQuery.getArchivedShellSnapshot?.() ??
      projectionSnapshotQuery.getShellSnapshot()
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load archived orchestration shell snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationShellSnapshot, {
      status: 200,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
    }),
  ),
);

export const orchestrationThreadSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/threads/:threadId/snapshot",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationReadScope);
    const params = yield* HttpRouter.params;
    const threadId = ThreadId.make(params.threadId ?? "");
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getThreadDetailSnapshotById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: `Failed to load thread ${threadId}`,
            cause,
          }),
      ),
    );
    if (snapshot._tag === "None") {
      return yield* new OrchestrationGetSnapshotError({
        message: `Thread ${threadId} was not found`,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      projectThreadDetailSnapshot(snapshot.value satisfies OrchestrationThreadDetailSnapshot),
      { status: 200 },
    );
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
    }),
  ),
);

export const orchestrationDispatchRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/dispatch",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationOperateScope);
    const orchestrationEngine = yield* OrchestrationEngineService;
    const startup = yield* ServerRuntimeStartup;
    const git = yield* GitCore;
    const gitStatusBroadcaster = yield* GitStatusBroadcaster;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const command = yield* HttpServerRequest.schemaBodyJson(ClientOrchestrationCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Invalid orchestration command payload.",
            cause,
          }),
      ),
    );

    const normalizedCommand = yield* normalizeDispatchCommand(command);
    const dispatchCommand = makeClientCommandDispatcher({
      orchestrationEngine,
      startup,
      git,
      gitStatusBroadcaster,
      projectSetupScriptRunner,
    });
    const result = yield* dispatchCommand(normalizedCommand);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationDispatchCommandError: respondToOrchestrationHttpError,
    }),
  ),
);

export const worktreeCleanupInventoryRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/worktree-cleanup/inventory",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationReadScope);
    const orchestrationEngine = yield* OrchestrationEngineService;
    const git = yield* GitCore;
    const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
    const readModel = yield* orchestrationEngine.getReadModel();
    const jobs = yield* worktreeCleanupJobs.list();
    const owners = new Map<string, Array<string>>();
    yield* Effect.forEach(
      readModel.threads.filter((thread) => thread.worktreePath !== null),
      (thread) =>
        Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath!)).pipe(
          Effect.map((path) => {
            const current = owners.get(path) ?? [];
            current.push(thread.id);
            owners.set(path, current);
          }),
        ),
      { concurrency: 4, discard: true },
    );
    const jobsByPath = new Map<string, Array<(typeof jobs)[number]>>();
    for (const job of jobs) {
      const pathJobs = jobsByPath.get(job.canonicalWorktreePath) ?? [];
      pathJobs.push(job);
      jobsByPath.set(job.canonicalWorktreePath, pathJobs);
    }
    const projects = new Map(
      readModel.projects
        .filter((project) => project.deletedAt === null)
        .map((project) => [project.workspaceRoot, project] as const),
    );
    const registeredPaths = new Set<string>();
    const worktrees = yield* Effect.forEach(
      projects.values(),
      (project) =>
        git.listRegisteredWorktrees(project.workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: `Failed to inventory Git worktrees for project ${project.id}.`,
                cause,
              }),
          ),
          Effect.flatMap((result) =>
            Effect.forEach(
              result.worktrees,
              (worktree) =>
                Effect.promise(() => canonicalizeWorktreePath(worktree.path)).pipe(
                  Effect.map((path) => {
                    registeredPaths.add(path);
                    const cleanupIntents = jobsByPath.get(path) ?? [];
                    return {
                      path,
                      repositoryRoot: project.workspaceRoot,
                      owners: owners.get(path) ?? [],
                      cleanupIntents: cleanupIntents.map((cleanup) => ({
                        threadId: cleanup.threadId,
                        source: cleanup.source,
                        status: cleanup.status,
                        reason: cleanup.lastReason,
                        nextAttemptAt: cleanup.nextAttemptAt,
                      })),
                    };
                  }),
                ),
              { concurrency: 4 },
            ),
          ),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((entries) => entries.flat()));
    const unregisteredJobsByPath = new Map<string, Array<(typeof jobs)[number]>>();
    for (const job of jobs) {
      if (registeredPaths.has(job.canonicalWorktreePath)) {
        continue;
      }
      const pathJobs = unregisteredJobsByPath.get(job.canonicalWorktreePath) ?? [];
      pathJobs.push(job);
      unregisteredJobsByPath.set(job.canonicalWorktreePath, pathJobs);
    }
    return HttpServerResponse.jsonUnsafe(
      {
        worktrees,
        unregisteredCleanupIntents: Array.from(unregisteredJobsByPath, ([path, pathJobs]) => ({
          path,
          owners: owners.get(path) ?? [],
          cleanupIntents: pathJobs.map((cleanup) => ({
            threadId: cleanup.threadId,
            source: cleanup.source,
            status: cleanup.status,
            reason: cleanup.lastReason,
            nextAttemptAt: cleanup.nextAttemptAt,
          })),
        })),
      },
      { status: 200 },
    );
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
    }),
  ),
);

export const worktreeCleanupRetryRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/worktree-cleanup/:threadId/retry",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationOperateScope);
    const params = yield* HttpRouter.params;
    const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
    const result = yield* worktreeCleanupJobs.retry({
      threadId: ThreadId.make(params.threadId ?? ""),
      nextAttemptAt: new Date().toISOString(),
    });
    return result._tag === "None"
      ? HttpServerResponse.jsonUnsafe(
          { error: "Cleanup intent is not retryable." },
          { status: 409 },
        )
      : HttpServerResponse.jsonUnsafe(result.value, { status: 200 });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
    }),
  ),
);

export const worktreeCleanupKeepRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/worktree-cleanup/:threadId/keep",
  Effect.gen(function* () {
    yield* authorizeClientSession(AuthOrchestrationOperateScope);
    const params = yield* HttpRouter.params;
    const threadId = ThreadId.make(params.threadId ?? "");
    const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
    yield* worktreeCleanupJobs.cancelByThreadId(threadId);
    const result = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (result._tag === "None") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Cleanup intent was not found." },
        { status: 404 },
      );
    }
    if (result.value.status === "removing") {
      return HttpServerResponse.jsonUnsafe(
        {
          error: "Cleanup removal is already in progress and could not be kept.",
          cleanup: result.value,
        },
        { status: 409 },
      );
    }
    return HttpServerResponse.jsonUnsafe(result.value, { status: 200 });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
    }),
  ),
);
