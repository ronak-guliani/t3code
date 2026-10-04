import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ProjectFaviconResolver } from "../project/Services/ProjectFaviconResolver.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const testLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(
    Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
        remove: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProjectFaviconResolver,
      ProjectFaviconResolver.of({ resolvePath: () => Effect.succeed(null) }),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ServerConfig, {} as ServerConfigShape)),
  Layer.provideMerge(NodeServices.layer),
);

const withWorkspace = <A, E, R>(
  use: (workspaceRoot: string, outsideRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureRoot = path.join(process.cwd(), `.asset-access-${randomUUID()}`);
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const outsideRoot = path.join(fixtureRoot, "outside");
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
    yield* fileSystem.makeDirectory(outsideRoot, { recursive: true });
    return yield* use(workspaceRoot, outsideRoot).pipe(
      Effect.ensuring(fileSystem.remove(fixtureRoot, { recursive: true }).pipe(Effect.ignore)),
    );
  });

function tokenFromRelativeUrl(relativeUrl: string): string {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  return suffix.slice(0, suffix.indexOf("/"));
}

describe("AssetAccess", () => {
  it.effect("issues a workspace capability for browser bytes and permitted sibling assets", () =>
    withWorkspace((workspaceRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const htmlPath = path.join(workspaceRoot, "report.html");
        const cssPath = path.join(workspaceRoot, "report.css");
        const pdfPath = path.join(workspaceRoot, "report.pdf");
        yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
        yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
        yield* fileSystem.writeFile(pdfPath, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));

        const htmlUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "report.html",
          },
          workspaceRoot,
        });
        const pdfUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "report.pdf",
          },
          workspaceRoot,
        });

        expect(
          yield* resolveAsset(tokenFromRelativeUrl(htmlUrl.relativeUrl), "report.html"),
        ).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(htmlPath),
        });
        expect(
          yield* resolveAsset(tokenFromRelativeUrl(htmlUrl.relativeUrl), "report.css"),
        ).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(cssPath),
        });
        expect(yield* resolveAsset(tokenFromRelativeUrl(pdfUrl.relativeUrl), "report.pdf")).toEqual(
          {
            kind: "file",
            path: yield* fileSystem.realPath(pdfPath),
          },
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues a read-only media grant for an explicitly referenced external file", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const externalPath = path.join(outsideRoot, "a report.png");
        yield* fileSystem.writeFile(externalPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

        const result = yield* Effect.exit(
          issueAssetUrl({
            resource: {
              _tag: "referenced-file",
              threadId: ThreadId.make("thread-1"),
              path: externalPath,
            },
            workspaceRoot,
          }),
        );
        expect(result._tag).toBe("Success");
        if (result._tag === "Success") {
          expect(result.value.fileReference).toEqual({
            name: "a report.png",
            mimeType: "image/png",
            sizeBytes: 4,
            viewMode: "media",
          });
          const token = tokenFromRelativeUrl(result.value.relativeUrl);
          expect(yield* resolveAsset(token, "a report.png")).toEqual({
            kind: "file",
            path: yield* fileSystem.realPath(externalPath),
          });
          const [payload, signature] = token.split(".");
          expect(
            yield* resolveAsset(
              `${payload}.${signature?.startsWith("a") ? "b" : "a"}${signature?.slice(1)}`,
              "a report.png",
            ),
          ).toBeNull();
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not grant external media paths without the explicit reference resource", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const result = yield* Effect.exit(
          issueAssetUrl({
            resource: {
              _tag: "media-file",
              threadId: ThreadId.make("thread-1"),
              path: path.join(outsideRoot, "report.png"),
            },
            workspaceRoot,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact download grants for unsupported external binaries", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const archive = path.join(outsideRoot, "archive.zip");
        yield* fileSystem.writeFile(archive, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        const url = yield* issueAssetUrl({
          resource: {
            _tag: "referenced-file",
            threadId: ThreadId.make("thread-1"),
            path: archive,
          },
          workspaceRoot,
        });
        expect(yield* resolveAsset(tokenFromRelativeUrl(url.relativeUrl), "archive.zip")).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(archive),
          forceDownload: true,
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("limits external HTML grants to safe canonical siblings", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(outsideRoot, "report.html"),
          "<link href='report.css'>",
        );
        yield* fileSystem.writeFileString(path.join(outsideRoot, "report.css"), "body {}");
        yield* fileSystem.writeFileString(path.join(outsideRoot, ".secret.css"), "secret");
        const secret = path.join(workspaceRoot, "secret.css");
        yield* fileSystem.writeFileString(secret, "private");
        yield* Effect.promise(() => symlink(secret, path.join(outsideRoot, "escape.css")));
        const url = yield* issueAssetUrl({
          resource: {
            _tag: "referenced-file",
            threadId: ThreadId.make("thread-1"),
            path: path.join(outsideRoot, "report.html"),
          },
          workspaceRoot,
        });
        const token = tokenFromRelativeUrl(url.relativeUrl);
        expect(yield* resolveAsset(token, "report.css")).not.toBeNull();
        expect(yield* resolveAsset(token, ".secret.css")).toBeNull();
        expect(yield* resolveAsset(token, "escape.css")).toBeNull();
        expect(yield* resolveAsset(token, "%2e%2e%2foutside.css")).toBeNull();
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a workspace path that escapes through a symlink", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outsideFile = path.join(outsideRoot, "escape.html");
        yield* fileSystem.writeFileString(outsideFile, "<p>outside</p>");
        yield* Effect.promise(() => symlink(outsideFile, path.join(workspaceRoot, "escape.html")));

        const error = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "escape.html",
          },
          workspaceRoot,
        }).pipe(Effect.flip);

        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
        const explicitReference = yield* Effect.exit(
          issueAssetUrl({
            resource: {
              _tag: "referenced-file",
              threadId: ThreadId.make("thread-1"),
              path: path.join(workspaceRoot, "escape.html"),
            },
            workspaceRoot,
          }),
        );
        expect(explicitReference._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues and resolves an attachment URL by id", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = path.join(outsideRoot, "attachments");
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        const attachmentId = "thread-1-abc123";
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fileSystem.writeFile(attachmentPath, new Uint8Array([137, 80, 78, 71, 13, 10]));
        const layer = Layer.provideMerge(
          Layer.succeed(ServerConfig, { attachmentsDir } as ServerConfigShape),
          testLayer,
        );

        const url = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: "shot.png",
            mimeType: "image/png",
            disposition: "inline",
          },
        }).pipe(Effect.provide(layer));

        const resolved = yield* resolveAsset(
          tokenFromRelativeUrl(url.relativeUrl),
          "shot.png",
        ).pipe(Effect.provide(layer));
        expect(resolved).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(attachmentPath),
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an unknown attachment id", () =>
    withWorkspace((_workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const layer = Layer.provideMerge(
          Layer.succeed(ServerConfig, {
            attachmentsDir: path.join(outsideRoot, "attachments"),
          } as ServerConfigShape),
          testLayer,
        );
        const error = yield* issueAssetUrl({
          resource: { _tag: "attachment", attachmentId: "thread-1-missing" },
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error._tag).toBe("AssetAttachmentNotFoundError");
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
