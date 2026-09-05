import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GitCommandError,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, FileSystem, Layer, PubSub, Ref, Stream } from "effect";
import { describe } from "vitest";
import { ServerConfig } from "../config.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";
import { GitCore } from "./Services/GitCore.ts";
import { ProjectAutoPull, ProjectAutoPullLive } from "./ProjectAutoPull.ts";
import { OrchestrationThread } from "@t3tools/contracts";
import { Schema } from "effect";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

const GitLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "auto-pull-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const core = yield* GitCore;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "auto-pull-" });
  const remote = `${root}/remote`;
  const cwd = `${root}/checkout`;
  const git = (path: string, args: readonly string[]) =>
    core
      .execute({ operation: "auto-pull.test", cwd: path, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["clone", remote, cwd]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* git(cwd, ["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(`${cwd}/file`, "initial\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial"]);
  yield* git(cwd, ["push", "-u", "origin", "main"]);
  const before = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* fs.writeFileString(`${cwd}/file`, "updated\n");
  yield* git(cwd, ["commit", "-am", "remote"]);
  yield* git(cwd, ["push"]);
  const after = yield* git(cwd, ["rev-parse", "HEAD"]);
  // Move only the disposable fixture's checkout behind its remote.
  yield* git(cwd, ["reset", "--keep", before]);
  const now = "1970-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("auto-pull");
  const model = yield* Ref.make({
    ...createEmptyReadModel(now),
    projects: [
      {
        id: projectId,
        title: "Test",
        workspaceRoot: cwd,
        autoPull: true,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
  });
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const serviceLayer = ProjectAutoPullLive.pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () => Ref.get(model),
        acquireDomainEventSubscription: PubSub.subscribe(events),
      }),
    ),
  );
  return { fs, core, root, cwd, before, after, git, model, events, serviceLayer, projectId, now };
});

describe("ProjectAutoPull", () => {
  it.effect("sweeps enabled projects on start", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* ProjectAutoPull;
        yield* service.start;
      }).pipe(Effect.provide(f.serviceLayer));
      assert.equal(yield* f.git(f.cwd, ["rev-parse", "HEAD"]), f.after);
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("attempts a pull when the persisted setting is enabled", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.update(f.model, (model) => ({
        ...model,
        projects: model.projects.map((project) => ({ ...project, autoPull: false })),
      }));
      yield* Effect.gen(function* () {
        const service = yield* ProjectAutoPull;
        const completed = yield* Deferred.make<void>();
        yield* service.changes.pipe(
          Stream.runForEach(() => Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
        yield* service.start;
        yield* Ref.update(f.model, (model) => ({
          ...model,
          projects: model.projects.map((project) => ({ ...project, autoPull: true })),
        }));
        yield* PubSub.publish(f.events, {
          sequence: 1,
          eventId: EventId.make("enabled"),
          aggregateKind: "project",
          aggregateId: f.projectId,
          type: "project.meta-updated",
          occurredAt: f.now,
          commandId: CommandId.make("enable"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { projectId: f.projectId, autoPull: true, updatedAt: f.now },
        });
        yield* Deferred.await(completed);
      }).pipe(Effect.provide(f.serviceLayer));
      assert.equal(yield* f.git(f.cwd, ["rev-parse", "HEAD"]), f.after);
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("deduplicates concurrent attempts through canonical path aliases", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const core = {
        ...f.core,
        execute: (input: Parameters<typeof f.core.execute>[0]) =>
          input.operation === "ProjectAutoPull.pull"
            ? Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* f.core.execute(input);
              })
            : f.core.execute(input),
      };
      yield* Effect.gen(function* () {
        const service = yield* ProjectAutoPull;
        const first = yield* service.attempt(f.cwd).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* service.attempt(`${f.cwd}/.`);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        assert.equal(calls, 1);
      }).pipe(Effect.provide(f.serviceLayer), Effect.provideService(GitCore, core));
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("backs off failed pulls instead of retrying on every refresh", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let calls = 0;
      const core = {
        ...f.core,
        execute: (input: Parameters<typeof f.core.execute>[0]) =>
          input.operation === "ProjectAutoPull.pull"
            ? Effect.suspend(() => {
                calls++;
                return Effect.fail(
                  new GitCommandError({
                    operation: "auto-pull.test",
                    cwd: f.cwd,
                    command: "git pull --ff-only",
                    detail: "fixture network failure",
                  }),
                );
              })
            : f.core.execute(input),
      };
      yield* Effect.gen(function* () {
        const service = yield* ProjectAutoPull;
        yield* service.attempt(f.cwd);
        yield* service.attempt(f.cwd);
        assert.equal(calls, 1);
        assert.equal(yield* f.git(f.cwd, ["rev-parse", "HEAD"]), f.before);
      }).pipe(Effect.provide(f.serviceLayer), Effect.provideService(GitCore, core));
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("rechecks local changes at the mutation boundary", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* ProjectAutoPull;
        yield* service.attempt(f.cwd);
      }).pipe(
        Effect.provide(f.serviceLayer),
        Effect.provideService(GitCore, {
          ...f.core,
          statusDetailsLocal: (cwd) =>
            f.fs
              .writeFileString(`${cwd}/file`, "concurrent local edit\n")
              .pipe(Effect.orDie, Effect.andThen(f.core.statusDetailsLocal(cwd))),
        }),
      );
      assert.equal(yield* f.git(f.cwd, ["rev-parse", "HEAD"]), f.before);
      assert.equal(yield* f.fs.readFileString(`${f.cwd}/file`), "concurrent local edit\n");
    }).pipe(Effect.provide(GitLayer)),
  );

  for (const condition of [
    "clean",
    "disabled",
    "dirty",
    "untracked",
    "hidden-untracked",
    "ahead",
    "feature",
    "no-upstream",
    "active",
    "other-worktree",
  ] as const) {
    it.effect(`handles ${condition} checkout`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (condition === "disabled") {
          yield* Ref.update(f.model, (model) => ({
            ...model,
            projects: model.projects.map((project) => ({ ...project, autoPull: false })),
          }));
        }
        if (condition === "dirty") yield* f.fs.writeFileString(`${f.cwd}/file`, "local\n");
        if (condition === "untracked") yield* f.fs.writeFileString(`${f.cwd}/untracked`, "local\n");
        if (condition === "hidden-untracked") {
          yield* f.fs.writeFileString(`${f.cwd}/untracked`, "local\n");
          yield* f.git(f.cwd, ["config", "status.showUntrackedFiles", "no"]);
        }
        if (condition === "ahead") {
          yield* f.fs.writeFileString(`${f.cwd}/local`, "local\n");
          yield* f.git(f.cwd, ["add", "."]);
          yield* f.git(f.cwd, ["commit", "-m", "local"]);
        }
        if (condition === "feature") yield* f.git(f.cwd, ["checkout", "-b", "feature"]);
        if (condition === "no-upstream") yield* f.git(f.cwd, ["branch", "--unset-upstream"]);
        if (condition === "active" || condition === "other-worktree") {
          const other = `${f.root}/other`;
          yield* f.fs.makeDirectory(other);
          const thread = decodeThread({
            id: ThreadId.make("active"),
            projectId: f.projectId,
            title: "Active",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: condition === "active" ? null : other,
            createdAt: f.now,
            updatedAt: f.now,
            deletedAt: null,
            archivedAt: null,
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            session: null,
            latestTurn: {
              turnId: TurnId.make("turn"),
              state: "running",
              requestedAt: f.now,
              startedAt: f.now,
              completedAt: null,
              assistantMessageId: null,
            },
          });
          yield* Ref.update(f.model, (model) => ({ ...model, threads: [thread] }));
        }
        const before = yield* f.git(f.cwd, ["rev-parse", "HEAD"]);
        yield* Effect.gen(function* () {
          const service = yield* ProjectAutoPull;
          yield* service.attempt(f.cwd);
          yield* service.attempt(f.cwd);
        }).pipe(Effect.provide(f.serviceLayer));
        const head = yield* f.git(f.cwd, ["rev-parse", "HEAD"]);
        assert.equal(
          head,
          condition === "clean" || condition === "other-worktree" ? f.after : before,
        );
      }).pipe(Effect.provide(GitLayer)),
    );
  }
});
