import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSourceStatus = Schema.Literals(["ready", "error"]);
export type ReviewDiffPreviewSourceStatus = typeof ReviewDiffPreviewSourceStatus.Type;

export const ReviewDiffFileSize = Schema.Literals(["normal", "large", "unrenderable"]);
export type ReviewDiffFileSize = typeof ReviewDiffFileSize.Type;

export const ReviewDiffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  previousPath: Schema.NullOr(TrimmedNonEmptyString),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  size: ReviewDiffFileSize,
  isBinary: Schema.Boolean,
  hasHiddenBidiChars: Schema.Boolean,
});
export type ReviewDiffFile = typeof ReviewDiffFile.Type;

export const ReviewDiffMetadata = Schema.Struct({
  filesChanged: NonNegativeInt,
  totalAdditions: NonNegativeInt,
  totalDeletions: NonNegativeInt,
  largeFiles: NonNegativeInt,
  unrenderableFiles: NonNegativeInt,
});
export type ReviewDiffMetadata = typeof ReviewDiffMetadata.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  status: ReviewDiffPreviewSourceStatus,
  error: Schema.NullOr(Schema.String),
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.Array(ReviewDiffFile),
  metadata: ReviewDiffMetadata,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
