import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitPullRequestAssociation,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import { GitManager } from "../../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PullRequestAssociationToolkitHandlersLive } from "./handlers.ts";
import { PullRequestAssociationToolkit } from "./tools.ts";

const projectId = ProjectId.make("proj_mcp");
const callerThreadId = ThreadId.make("thr_caller");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env_1"),
  threadId: callerThreadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("opencode"),
  capabilities: new Set([]),
  issuedAt: 1,
};

const pullRequest = (number: number): GitPullRequestAssociation => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseBranch: "main",
  headBranch: `feature/${number}`,
  state: "open",
});

const shellWith = (overrides: Record<string, unknown> = {}) =>
  ({
    id: callerThreadId,
    projectId,
    pullRequest: null,
    pullRequests: [],
    updatedAt: "2026-09-17T00:00:00.000Z",
    worktreePath: "/work/threads/thr_caller",
    ...overrides,
  }) as never;

const checkpointWith = (overrides: Record<string, unknown> = {}) =>
  ({
    threadId: callerThreadId,
    projectId,
    workspaceRoot: "/work/project",
    worktreePath: "/work/threads/thr_caller",
    checkpoints: [],
    ...overrides,
  }) as never;

const makeLayer = (input: {
  readonly shell?: Record<string, unknown>;
  readonly checkpoint?: Record<string, unknown> | null;
  readonly resolvedNumber?: number;
  readonly onCommand?: (command: OrchestrationCommand) => void;
  readonly seenCwd?: { readonly cwd: string; readonly reference: string }[];
}) => {
  const fakeProjections = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === callerThreadId ? Option.some(shellWith(input.shell)) : Option.none(),
      ),
    getThreadCheckpointContext: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === callerThreadId && input.checkpoint !== null
          ? Option.some(checkpointWith(input.checkpoint ?? {}))
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];

  const fakeGit = GitManager.of({
    resolvePullRequest: ({
      cwd,
      reference,
    }: {
      readonly cwd: string;
      readonly reference: string;
    }) =>
      Effect.sync(() => {
        input.seenCwd?.push({ cwd, reference });
        return { pullRequest: pullRequest(input.resolvedNumber ?? 42) };
      }),
  } as unknown as GitManager["Service"]);

  const fakeEngine = OrchestrationEngineService.of({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        input.onCommand?.(command);
        return { sequence: 1 } as never;
      }),
  } as unknown as OrchestrationEngineService["Service"]);

  return PullRequestAssociationToolkitHandlersLive.pipe(
    Layer.provideMerge(Layer.succeed(GitManager, fakeGit)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, fakeEngine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, fakeProjections)),
  );
};

const callTool = (name: string, payload: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* PullRequestAssociationToolkit;
    const outcome = (yield* toolkit
      .handle(name as never, payload as never)
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption))) as {
      readonly result?: unknown;
    };
    return outcome?.result;
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

it.effect("associates the resolved PR with the calling chat workspace", () =>
  Effect.gen(function* () {
    const seen: OrchestrationCommand[] = [];
    const seenCwd: { readonly cwd: string; readonly reference: string }[] = [];
    const result = (yield* callTool("associate_pull_request", {
      reference: "https://github.com/acme/app/pull/42",
    }).pipe(
      Effect.provide(makeLayer({ onCommand: (command) => seen.push(command), seenCwd })),
    )) as { readonly pullRequest: GitPullRequestAssociation };

    assert.strictEqual(result.pullRequest.number, 42);
    assert.deepStrictEqual(seenCwd, [
      { cwd: "/work/threads/thr_caller", reference: "https://github.com/acme/app/pull/42" },
    ]);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0]?.type, "thread.meta.update");
    assert.strictEqual(seen[1]?.type, "thread.pull-request.link");
    assert.strictEqual((seen[1] as { readonly source?: string }).source, "agent");
    for (const command of seen) {
      assert.strictEqual((command as { readonly threadId?: unknown }).threadId, callerThreadId);
    }
  }),
);

it.effect("links without changing the workspace pull request", () =>
  Effect.gen(function* () {
    const seen: OrchestrationCommand[] = [];
    yield* callTool("link_pull_request", { reference: "42" }).pipe(
      Effect.provide(makeLayer({ onCommand: (command) => seen.push(command) })),
    );

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.type, "thread.pull-request.link");
    assert.strictEqual((seen[0] as { readonly source?: string }).source, "manual");
  }),
);

it.effect("unlinks the resolved PR from the calling chat", () =>
  Effect.gen(function* () {
    const seen: OrchestrationCommand[] = [];
    const result = (yield* callTool("unlink_pull_request", { reference: "42" }).pipe(
      Effect.provide(makeLayer({ onCommand: (command) => seen.push(command) })),
    )) as { readonly pullRequest: GitPullRequestAssociation };

    assert.strictEqual(result.pullRequest.number, 42);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.type, "thread.pull-request.unlink");
  }),
);

it.effect("lists linked pull requests for the calling chat", () =>
  Effect.gen(function* () {
    const result = (yield* callTool("list_thread_pull_requests", {}).pipe(
      Effect.provide(
        makeLayer({
          shell: {
            pullRequests: [
              {
                pullRequest: pullRequest(42),
                source: "agent",
                linkedAt: "2026-09-17T00:00:00.000Z",
              },
            ],
          },
        }),
      ),
    )) as {
      readonly pullRequests: ReadonlyArray<{ readonly pullRequest: GitPullRequestAssociation }>;
    };

    assert.strictEqual(result.pullRequests.length, 1);
    assert.strictEqual(result.pullRequests[0]?.pullRequest.number, 42);
  }),
);

it.effect("falls back to the project root when the thread has no worktree", () =>
  Effect.gen(function* () {
    const seenCwd: { readonly cwd: string; readonly reference: string }[] = [];
    yield* callTool("link_pull_request", { reference: "42" }).pipe(
      Effect.provide(makeLayer({ checkpoint: { worktreePath: null }, seenCwd })),
    );

    assert.deepStrictEqual(seenCwd, [{ cwd: "/work/project", reference: "42" }]);
  }),
);

it.effect("refuses calls when the calling chat is gone", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      callTool("link_pull_request", { reference: "42" }).pipe(
        Effect.provide(
          PullRequestAssociationToolkitHandlersLive.pipe(
            Layer.provideMerge(
              Layer.succeed(ProjectionSnapshotQuery, {
                getThreadShellById: () => Effect.succeed(Option.none()),
                getThreadCheckpointContext: () => Effect.succeed(Option.none()),
              } as unknown as ProjectionSnapshotQuery["Service"]),
            ),
          ),
        ),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it("exposes provider-compatible object schemas with described tools", () => {
  for (const tool of Object.values(PullRequestAssociationToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    assert.isTrue(
      (tool.description?.length ?? 0) > 40,
      `${tool.name} should have a useful description`,
    );
    assert.strictEqual(schema.type, "object", `${tool.name} must export a top-level object schema`);
    assert.isUndefined(schema.anyOf, `${tool.name} must not export a root anyOf`);
    assert.isUndefined(schema.oneOf, `${tool.name} must not export a root oneOf`);
  }
});
