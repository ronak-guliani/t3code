import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlink } from "node:fs/promises";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });
  describe("readFile", () => {
    it.effect("reads files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "docs/preview.html", "<h1>Preview</h1>");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "docs/preview.html",
        });

        expect(result).toEqual({
          relativePath: "docs/preview.html",
          contents: "<h1>Preview</h1>",
          byteLength: 16,
          truncated: false,
        });
      }),
    );

    it.effect("limits file previews to the first 1 MB", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", `${"a".repeat(1024 * 1024)}tail`);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large.txt",
        });

        expect(result.contents).toHaveLength(1024 * 1024);
        expect(result.contents.endsWith("tail")).toBe(false);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("marks binary files as non-editable previews", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFile(
          path.join(cwd, "image.png"),
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "image.png",
        });

        expect(result).toMatchObject({
          relativePath: "image.png",
          contents: "",
          byteLength: 6,
          truncated: false,
          binary: true,
        });
      }),
    );

    it.effect("keeps truncated multibyte UTF-8 text previewable", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        for (const character of ["\u00e9", "\u20ac", "\u{1f600}"]) {
          for (let cut = 1; cut < new TextEncoder().encode(character).length; cut++) {
            const prefix = "a".repeat(1024 * 1024 - cut);
            yield* writeTextFile(cwd, "large.txt", `${prefix}${character}tail`);
            const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.txt" });
            expect(result.binary).not.toBe(true);
            expect(result.truncated).toBe(true);
            expect(result.contents).toBe(prefix);
          }
        }
      }),
    );

    it.effect("still rejects malformed UTF-8 inside truncated previews and at EOF", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const malformedLargeFile = new Uint8Array(1024 * 1024 + 1).fill(0x61);
        malformedLargeFile[0] = 0xff;
        for (const bytes of [new Uint8Array([0xe2, 0x82]), malformedLargeFile]) {
          yield* fileSystem.writeFile(path.join(cwd, "invalid.txt"), bytes);
          const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "invalid.txt" });
          expect(result.binary).toBe(true);
          expect(result.contents).toBe("");
        }
      }),
    );

    it.effect("rejects a symbolic link that escapes the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const workspaceRoot = yield* makeTempDir;
        const outsideRoot = yield* makeTempDir;
        yield* writeTextFile(outsideRoot, "secret.txt", "secret");

        yield* Effect.promise(() => symlink(outsideRoot, `${workspaceRoot}/linked`));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd: workspaceRoot,
            relativePath: "linked/secret.txt",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          operation: "workspaceFileSystem.readFile",
          detail: "Workspace file path cannot traverse symbolic links",
        });
      }),
    );
  });
});
