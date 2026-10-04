import type { AssetResource, ResolvedFileReference } from "@t3tools/contracts";
import Mime from "@effect/platform-node/Mime";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ProjectFaviconResolver } from "../project/Services/ProjectFaviconResolver.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
const EXTERNAL_FILE_TOKEN_TTL_MS = 5 * 60 * 1000;
const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
  ".mp4",
  ".webm",
  ".mov",
  ".mp3",
  ".wav",
  ".json",
]);
const TEXT_REFERENCE_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".mdx",
  ".rs",
  ".go",
  ".sh",
  ".css",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".java",
  ".kt",
  ".sql",
  ".xml",
  ".csv",
  ".ini",
]);

function resolveFileReference(path: string, sizeBytes: number): ResolvedFileReference {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const mimeType = Mime.getType(path) ?? "application/octet-stream";
  const viewMode = /\.html?$/i.test(path)
    ? "html"
    : extension === ".pdf"
      ? "document"
      : /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|mov|mp3|wav)$/i.test(path)
        ? "media"
        : TEXT_REFERENCE_EXTENSIONS.has(extension)
          ? "text"
          : "download";
  return {
    name:
      path
        .slice(path.lastIndexOf("/") + 1)
        .split("\\")
        .at(-1) ?? path,
    mimeType,
    sizeBytes,
    viewMode,
  };
}

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Finite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    download: Schema.optional(Schema.Boolean),
    expiresAt: Schema.Finite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("external-file-exact"),
    absolutePath: Schema.String,
    download: Schema.Boolean,
    expiresAt: Schema.Finite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("external-preview-directory"),
    directory: Schema.String,
    expiresAt: Schema.Finite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    expiresAt: Schema.Finite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Finite,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset = {
  readonly kind: "file";
  readonly path: string;
  readonly forceDownload?: boolean;
};

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

/**
 * Resolves both the workspace root and target through the filesystem, then
 * checks containment after symlinks have been evaluated.
 */
const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeed(Option.none()),
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all(
      [
        optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
        optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let effectiveExpiresAt = expiresAt;
  let claims: AssetClaims;
  let fileName: string;
  let fileReference: ReturnType<typeof resolveFileReference> | undefined;

  switch (input.resource._tag) {
    case "native-app-icon":
      return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
    case "media-file":
    case "referenced-file":
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
      }
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.workspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceRootNormalizationError({ resource: input.resource, cause }),
          ),
        );
      const relativePath = path.isAbsolute(input.resource.path)
        ? path.relative(workspaceRoot, input.resource.path)
        : input.resource.path;
      const absolutePathIsInsideWorkspace =
        path.isAbsolute(input.resource.path) &&
        (() => {
          const relative = path.relative(workspaceRoot, input.resource.path);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        })();
      if (
        input.resource._tag === "referenced-file" &&
        path.isAbsolute(input.resource.path) &&
        !absolutePathIsInsideWorkspace
      ) {
        const canonicalPath = yield* fileSystem.realPath(input.resource.path).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceAssetInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        const fileInfo = yield* fileSystem.stat(canonicalPath).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceAssetInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        if (fileInfo.type !== "File") {
          return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
        }
        if (input.resource._tag === "referenced-file") {
          fileReference = resolveFileReference(canonicalPath, Number(fileInfo.size));
        }
        const canonicalRoot = yield* fileSystem.realPath(workspaceRoot).pipe(Effect.option);
        const withinWorkspace =
          Option.isSome(canonicalRoot) &&
          (() => {
            const rel = path.relative(canonicalRoot.value, canonicalPath);
            return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
          })();
        if (!withinWorkspace) {
          const ext = path.extname(canonicalPath).toLowerCase();
          const download =
            !PREVIEW_ASSET_EXTENSIONS.has(ext) && !TEXT_REFERENCE_EXTENSIONS.has(ext);
          if (download && input.resource._tag !== "referenced-file") {
            return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
          }
          const isHtml = /\.html?$/i.test(canonicalPath);
          const directory = isHtml
            ? yield* fileSystem.realPath(path.dirname(canonicalPath)).pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceAssetInspectionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              )
            : null;
          const externalExpiry = (yield* Clock.currentTimeMillis) + EXTERNAL_FILE_TOKEN_TTL_MS;
          effectiveExpiresAt = externalExpiry;
          claims = directory
            ? {
                version: 1,
                kind: "external-preview-directory",
                directory,
                expiresAt: externalExpiry,
              }
            : {
                version: 1,
                kind: "external-file-exact",
                absolutePath: canonicalPath,
                download,
                expiresAt: externalExpiry,
              };
          fileName = path.basename(canonicalPath);
          break;
        }
      }
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
        .pipe(
          Effect.mapError(
            (cause) => new AssetWorkspacePathValidationError({ resource: input.resource, cause }),
          ),
        );
      const download =
        !isWorkspacePreviewEntryPath(resolved.relativePath) &&
        !TEXT_REFERENCE_EXTENSIONS.has(path.extname(resolved.relativePath).toLowerCase());
      if (download && input.resource._tag !== "referenced-file") {
        return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
      }
      const canonicalFile = yield* resolveCanonicalWorkspaceFile({
        workspaceRoot,
        relativePath: resolved.relativePath,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceAssetInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (!canonicalFile) {
        return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
      }
      if (input.resource._tag === "referenced-file") {
        const info = yield* fileSystem
          .stat(canonicalFile)
          .pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
            ),
          );
        fileReference = resolveFileReference(canonicalFile, Number(info.size));
      }
      const canonicalWorkspaceRoot = yield* fileSystem
        .realPath(workspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) => new AssetWorkspaceResolutionError({ resource: input.resource, cause }),
          ),
        );
      claims = isWorkspaceImagePreviewPath(resolved.relativePath)
        ? {
            version: 1,
            kind: "workspace-file-exact",
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            ...(download ? { download: true } : {}),
            expiresAt,
          }
        : download
          ? {
              version: 1,
              kind: "workspace-file-exact",
              workspaceRoot: canonicalWorkspaceRoot,
              relativePath: resolved.relativePath,
              download: true,
              expiresAt,
            }
          : {
              version: 1,
              kind: "workspace-file",
              workspaceRoot: canonicalWorkspaceRoot,
              baseRelativePath: path.dirname(resolved.relativePath),
              expiresAt,
            };
      fileName = path.basename(resolved.relativePath);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
      }
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.workspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceRootNormalizationError({ resource: input.resource, cause }),
          ),
        );
      const faviconResolver = yield* ProjectFaviconResolver;
      const faviconPath = yield* faviconResolver.resolvePath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetProjectFaviconResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = faviconPath ? path.relative(workspaceRoot, faviconPath) : null;
      if (
        relativePath &&
        !(yield* resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath }).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        ))
      ) {
        return yield* new AssetProjectFaviconNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "project-favicon",
        workspaceRoot: yield* fileSystem
          .realPath(workspaceRoot)
          .pipe(
            Effect.mapError(
              (cause) => new AssetWorkspaceResolutionError({ resource: input.resource, cause }),
            ),
          ),
        relativePath,
        expiresAt,
      };
      fileName = relativePath ? path.basename(relativePath) : PROJECT_FAVICON_FALLBACK_MARKER;
      break;
    }
  }

  const secretStore = yield* ServerSecretStore;
  const signingSecret = yield* secretStore
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(
      Effect.mapError((cause) => new AssetSigningKeyLoadError({ resource: input.resource, cause })),
    );
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt: effectiveExpiresAt,
    ...(fileReference ? { fileReference } : {}),
  };
});

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (
    !signingSecret ||
    !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))
  ) {
    return null;
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: attachmentPath } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? ({ kind: "file", path: faviconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;

  if (claims.kind === "external-file-exact") {
    const fileSystem = yield* FileSystem.FileSystem;
    const canonicalPath = yield* fileSystem
      .realPath(claims.absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!canonicalPath || path.basename(canonicalPath) !== decodedPath) return null;
    const info = yield* optionOnNotFound(fileSystem.stat(canonicalPath)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({
          kind: "file",
          path: canonicalPath,
          ...(claims.download ? { forceDownload: true } : {}),
        } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "external-preview-directory") {
    const segments = decodedPath.split(/[\\/]/);
    if (
      decodedPath.length === 0 ||
      decodedPath.includes("\0") ||
      segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
      !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
    )
      return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const joinedPath = path.resolve(claims.directory, decodedPath);
    const canonicalRoot = yield* fileSystem
      .realPath(claims.directory)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const canonicalFile = yield* fileSystem
      .realPath(joinedPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!canonicalRoot || !canonicalFile) return null;
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: canonicalFile } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({
          kind: "file",
          path: exactWorkspaceFile,
          ...(claims.download ? { forceDownload: true } : {}),
        } satisfies ResolvedAsset)
      : null;
  }

  const segments = decodedPath.split(/[\\/]/);
  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile ? ({ kind: "file", path: workspaceFile } satisfies ResolvedAsset) : null;
});
