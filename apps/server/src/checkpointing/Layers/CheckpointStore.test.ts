import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { checkpointBaselineRefForThreadTurn, checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import {
  GitCore,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../../git/Services/GitCore.ts";
import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { CheckpointRef, ThreadId } from "@t3tools/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, CheckpointStoreTestLayer);

function executeGitResult(code: number, stdout = ""): ExecuteGitResult {
  return {
    code,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "CheckpointStore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

function buildOversizedSingleLine(): string {
  return `${"x".repeat(11_000_000)}\n`;
}

function buildNumberedLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index)}`)
    .join("\n")
    .concat("\n");
}

function replaceLine(contents: string, lineIndex: number, replacement: string): string {
  const lines = contents.split("\n");
  lines[lineIndex] = replacement;
  return lines.join("\n");
}

describe("CheckpointStoreLive range resolution", () => {
  it.effect("resolves preferred, fallback, and target checkpoint refs only once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-checkpoint-store-range-resolution");
      const preferredFromCheckpointRef = checkpointBaselineRefForThreadTurn(threadId, 1);
      const fallbackFromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const executeInputs: Array<ExecuteGitInput> = [];
      const gitCoreLayer = Layer.mock(GitCore)({
        execute: (input) =>
          Effect.sync(() => {
            executeInputs.push(input);
            const revision = input.args[3];
            if (revision === `${preferredFromCheckpointRef}^{commit}`) {
              return executeGitResult(1);
            }
            if (revision === `${fallbackFromCheckpointRef}^{commit}`) {
              return executeGitResult(0, "from-oid\n");
            }
            if (revision === `${toCheckpointRef}^{commit}`) {
              return executeGitResult(0, "to-oid\n");
            }
            if (revision === "from-oid^" || revision === "to-oid^") {
              return executeGitResult(0, "base-oid\n");
            }
            if (input.args[0] === "diff") {
              return executeGitResult(0, "diff --git a/README.md b/README.md\n+# changed\n");
            }
            throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
          }),
      });
      const checkpointStoreLayer = CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      );
      const diff = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return yield* checkpointStore.diffCheckpoints({
          cwd: "/tmp/workspace",
          fromCheckpointRef: preferredFromCheckpointRef,
          fallbackFromCheckpointRef,
          toCheckpointRef,
        });
      }).pipe(Effect.provide(checkpointStoreLayer));

      const checkpointRefLookups = executeInputs
        .filter(
          (input) =>
            input.args[0] === "rev-parse" &&
            input.args[1] === "--verify" &&
            input.args[2] === "--quiet" &&
            input.args[3]?.startsWith("refs/t3/checkpoints/") === true,
        )
        .map((input) => input.args[3]);

      expect(checkpointRefLookups.toSorted()).toEqual(
        [
          `${preferredFromCheckpointRef}^{commit}`,
          `${fallbackFromCheckpointRef}^{commit}`,
          `${toCheckpointRef}^{commit}`,
        ].toSorted(),
      );
      expect(diff).toContain("+# changed");
    }),
  );
});

describe("CheckpointStoreLive diff cache", () => {
  function makeDiffCacheTestLayer(options?: {
    readonly diffResult?: string;
    readonly missingFromCheckpoint?: boolean;
  }) {
    let diffCalls = 0;
    const gitCoreLayer = Layer.mock(GitCore)({
      execute: (input) =>
        Effect.sync(() => {
          const revision = input.args[3];
          if (revision?.endsWith("^{commit}") === true) {
            if (revision === "HEAD^{commit}") {
              return executeGitResult(0, "head-oid\n");
            }
            if (options?.missingFromCheckpoint === true && revision.includes("/from")) {
              return executeGitResult(1);
            }
            return executeGitResult(0, revision.includes("/from") ? "from-oid\n" : "to-oid\n");
          }
          if (revision === "from-oid^" || revision === "to-oid^") {
            return executeGitResult(0, "base-oid\n");
          }
          if (input.args[0] === "diff") {
            diffCalls += 1;
            return executeGitResult(0, options?.diffResult ?? `diff-${diffCalls}\n`);
          }
          throw new Error(`Unexpected Git command: ${input.args.join(" ")}`);
        }),
    });
    return {
      getDiffCalls: () => diffCalls,
      layer: CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer),
        Layer.provide(NodeServices.layer),
      ),
    };
  }

  it.effect("reuses an exact immutable checkpoint-pair diff", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer();
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
        paths: ["README.md"],
      };

      const [first, second] = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return [
          yield* checkpointStore.diffCheckpoints(input),
          yield* checkpointStore.diffCheckpoints({ ...input, paths: ["README.md"] }),
        ];
      }).pipe(Effect.provide(test.layer));

      expect(first).toBe("diff-1\n");
      expect(second).toBe(first);
      expect(test.getDiffCalls()).toBe(1);
    }),
  );

  it.effect("misses when an immutable checkpoint-pair cache key changes", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer();
      const baseInput = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.diffCheckpoints(baseInput);
        yield* checkpointStore.diffCheckpoints({ ...baseInput, ignoreWhitespace: true });
        yield* checkpointStore.diffCheckpoints({ ...baseInput, paths: ["README.md"] });
      }).pipe(Effect.provide(test.layer));

      expect(test.getDiffCalls()).toBe(3);
    }),
  );

  it.effect("does not cache diffs that fall back to the mutable workspace HEAD", () =>
    Effect.gen(function* () {
      const test = makeDiffCacheTestLayer({ missingFromCheckpoint: true });
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
        fallbackFromToHead: true,
      };

      const [first, second] = yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        return [
          yield* checkpointStore.diffCheckpoints(input),
          yield* checkpointStore.diffCheckpoints(input),
        ];
      }).pipe(Effect.provide(test.layer));

      expect(first).toBe("diff-1\n");
      expect(second).toBe("diff-2\n");
      expect(test.getDiffCalls()).toBe(2);
    }),
  );

  it.effect("does not retain diff results that exceed the per-entry byte budget", () =>
    Effect.gen(function* () {
      const largeDiff = "x".repeat(129 * 1024);
      const test = makeDiffCacheTestLayer({ diffResult: largeDiff });
      const input = {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/from"),
        toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/to"),
      };

      yield* Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        yield* checkpointStore.diffCheckpoints(input);
        yield* checkpointStore.diffCheckpoints(input);
      }).pipe(Effect.provide(test.layer));

      expect(test.getDiffCalls()).toBe(2);
    }),
  );
});

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("checkpointRefMatchesWorkspace", () => {
    it.effect("rejects a baseline after the same worktree switches branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-branch-switch"),
          0,
        );

        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* writeTextFile(path.join(tmp, "feature.md"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "feature"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* git(tmp, ["checkout", "-b", "replacement", "HEAD^"]);

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when dirty workspace contents change without moving HEAD", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-dirty-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# dirty\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when only the staged workspace contents change", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-staged-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );
  });

  describe("restoreCheckpoint", () => {
    it.effect("restores staged, unstaged, and untracked workspace state separately", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-restore-staging"),
          0,
        );

        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# unstaged\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["clean", "-fd"]);

        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);
        expect(yield* git(tmp, ["show", ":README.md"])).toBe("# staged");
        expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe("# unstaged\n");
        expect(yield* fileSystem.readFileString(path.join(tmp, "untracked.md"))).toBe(
          "untracked\n",
        );
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("honors ignoreWhitespace for whitespace-only changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "#    test\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toBe("");
      }),
    );

    it.effect("excludes same-branch fast-forward pull changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-fast-forward");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        const oldHead = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* git(tmp, ["checkout", "-b", "upstream-branch"]);
        yield* writeTextFile(path.join(tmp, "upstream-b.md"), "upstream b\n");
        yield* git(tmp, ["add", "upstream-b.md"]);
        yield* git(tmp, ["commit", "-m", "upstream change b"]);
        const upstreamHeadB = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["branch", "older-upstream-tip", upstreamHeadB]);
        yield* writeTextFile(path.join(tmp, "upstream-c.md"), "upstream c\n");
        yield* git(tmp, ["add", "upstream-c.md"]);
        yield* git(tmp, ["commit", "-m", "upstream change c"]);
        const upstreamHeadC = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["branch", "-D", "upstream-branch"]);
        yield* git(tmp, [
          "update-ref",
          "-m",
          "pull: Fast-forward",
          "refs/heads/thread-branch",
          upstreamHeadB,
          oldHead,
        ]);
        yield* git(tmp, ["read-tree", "--reset", "-u", upstreamHeadB]);
        yield* git(tmp, [
          "update-ref",
          "-m",
          "pull: Fast-forward",
          "refs/heads/thread-branch",
          upstreamHeadC,
          upstreamHeadB,
        ]);
        yield* git(tmp, ["read-tree", "--reset", "-u", upstreamHeadC]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# turn change\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "turn change"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+# turn change");
        expect(diff).not.toContain("upstream-b.md");
        expect(diff).not.toContain("upstream-c.md");
        expect(diff).not.toContain("+upstream b");
        expect(diff).not.toContain("+upstream c");
      }),
    );

    it.effect("excludes base movement that entered the workspace during the turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-base-movement");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Another branch advances the base while the turn is running.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // The turn commits its own work, then rebases onto the advanced base.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("keeps turn-authored commits that a stacked branch forked from mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-stacked");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);

        // A branch forked from an intermediate turn commit does not contain the
        // turn's final commit, so reachability alone would read the commit it
        // points at as the base the turn started from.
        yield* git(tmp, ["branch", "stacked-branch"]);

        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("keeps earlier turns' commits out of a diff whose base was rebased", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-rebased-base");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        // The thread already carries a committed earlier turn, so the rebase
        // rewrites thread history and the old base leaves the new base's chain.
        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "earlier turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
        expect(diff).not.toContain("+earlier change");
      }),
    );

    it.effect("keeps turn-authored commits that a mid-turn push left a remote ref on", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-pushed");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const pushedContents = replaceLine(
          replaceLine(buildNumberedLines(30), 1, "foreign change"),
          5,
          "pushed change",
        );
        yield* writeTextFile(sharedPath, pushedContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        // A mid-turn push leaves the branch's remote-tracking ref on the turn's
        // own commit; that must not be read as the base the turn started from.
        const pushedCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["update-ref", "refs/remotes/origin/thread-branch", pushedCommit]);

        yield* writeTextFile(sharedPath, replaceLine(pushedContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+pushed change");
      }),
    );

    it.effect("excludes a base the turn merged in mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-merge");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // A merge keeps the turn's history as its first parent, so the adopted
        // base is only reachable through the merge's second parent.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["merge", "--no-edit", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("ignores base movement from a later turn when diffing an earlier one", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-later-turn");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Turn 2 moves no base; a stacked branch forks between its commits.
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        yield* git(tmp, ["branch", "stacked-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        // Turn 3 rebases. Diffing turn 2 afterwards must not see that rebase.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("limits checkpoint diffs to validated repo-relative paths", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-paths");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* writeTextFile(path.join(tmp, "other.md"), "# other\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          paths: ["README.md", ":!other.md", "../outside.md"],
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).not.toContain("other.md");
      }),
    );
  });

  describe("diffCheckpointFiles", () => {
    it.effect("preserves rename metadata for paths with spaces", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-rename-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* git(tmp, ["mv", "README.md", "renamed file.md"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const files = yield* checkpointStore.diffCheckpointFiles({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(files).toEqual([
          {
            path: "renamed file.md",
            previousPath: "README.md",
            kind: "renamed",
            additions: 0,
            deletions: 0,
          },
        ]);
      }),
    );

    it.effect(
      "returns file summaries for checkpoint diffs whose patch exceeds the output limit",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-checkpoint-store-large-file-summary");
          const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
          const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: fromCheckpointRef,
          });
          yield* writeTextFile(path.join(tmp, "README.md"), buildOversizedSingleLine());
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: toCheckpointRef,
          });

          const files = yield* checkpointStore.diffCheckpointFiles({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
          });

          expect(files).toEqual([
            {
              path: "README.md",
              previousPath: null,
              kind: "modified",
              additions: 1,
              deletions: 1,
            },
          ]);
        }),
    );
  });
});
