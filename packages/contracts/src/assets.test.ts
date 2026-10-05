import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { FileReference, ResolvedFileReference } from "./assets.ts";

const decodeFileReference = Schema.decodeUnknownSync(FileReference);
const decodeResolvedFileReference = Schema.decodeUnknownSync(ResolvedFileReference);

describe("file reference contracts", () => {
  it("keeps authored path references scoped to their owning environment and position", () => {
    expect(
      decodeFileReference({
        _tag: "path",
        environmentId: EnvironmentId.make("environment-owner"),
        threadId: ThreadId.make("thread-owner"),
        path: "/tmp/report café.ts",
        line: 9,
        column: 4,
      }),
    ).toMatchObject({
      _tag: "path",
      environmentId: "environment-owner",
      threadId: "thread-owner",
      path: "/tmp/report café.ts",
      line: 9,
      column: 4,
    });
  });

  it("supports attachment identity separately from file paths and ephemeral URLs", () => {
    expect(
      decodeFileReference({
        _tag: "attachment",
        environmentId: EnvironmentId.make("environment-owner"),
        threadId: ThreadId.make("thread-owner"),
        attachmentId: "thread-owner-abc123",
      }),
    ).toMatchObject({ _tag: "attachment", attachmentId: "thread-owner-abc123" });
  });

  it("validates server-resolved presentation metadata", () => {
    expect(
      decodeResolvedFileReference({
        name: "report.html",
        mimeType: "text/html",
        sizeBytes: 1_024,
        viewMode: "html",
      }).viewMode,
    ).toBe("html");
  });
});
