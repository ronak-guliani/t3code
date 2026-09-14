import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  importedMessageText,
  readChatArchive,
  type ChatArchiveManifest,
  writeChatArchive,
} from "./chatArchive.ts";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function manifest(): ChatArchiveManifest {
  return {
    format: "t3-chat-archive",
    version: 1,
    archiveId: "archive-1",
    title: "Imported chats - 2026-09-14",
    exportedAt: "2026-09-14T20:00:00.000Z",
    threads: [
      {
        sourceThreadId: "thread-1",
        sourceParentThreadId: null,
        sourceProjectTitle: "T3 Code",
        sourceWorkspaceRoot: "/code/t3code",
        title: "Transfer chats",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-09-14T19:00:00.000Z",
        updatedAt: "2026-09-14T19:10:00.000Z",
        messages: [
          {
            role: "user",
            text: "Move my chats",
            attachments: [],
            sourceTurnId: "turn-1",
            createdAt: "2026-09-14T19:00:00.000Z",
            updatedAt: "2026-09-14T19:00:00.000Z",
          },
        ],
      },
    ],
  };
}

describe("chat archives", () => {
  it("writes and reads a versioned archive folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-chat-archive-"));
    createdPaths.push(root);

    const path = await writeChatArchive(root, manifest());

    await expect(readChatArchive(path)).resolves.toEqual(manifest());
    expect(JSON.parse(await readFile(join(path, "manifest.json"), "utf8"))).toMatchObject({
      format: "t3-chat-archive",
      version: 1,
    });
  });

  it("rejects archives with broken hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-chat-archive-invalid-"));
    createdPaths.push(root);
    const path = join(root, "archive");
    await mkdir(path);
    const source = manifest();
    const invalid: ChatArchiveManifest = {
      ...source,
      threads: [{ ...source.threads[0]!, sourceParentThreadId: "missing" }],
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(invalid));

    await expect(readChatArchive(path)).rejects.toThrow("invalid chat hierarchy");
  });

  it("rejects archives with cyclic hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-chat-archive-cycle-"));
    createdPaths.push(root);
    const path = join(root, "archive");
    await mkdir(path);
    const source = manifest();
    const invalid: ChatArchiveManifest = {
      ...source,
      threads: [
        { ...source.threads[0]!, sourceParentThreadId: "thread-2" },
        {
          ...source.threads[0]!,
          sourceThreadId: "thread-2",
          sourceParentThreadId: "thread-1",
          messages: [],
        },
      ],
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(invalid));

    await expect(readChatArchive(path)).rejects.toThrow("cyclic chat hierarchy");
  });

  it("renders omitted attachment metadata into the imported transcript", () => {
    expect(
      importedMessageText({
        role: "user",
        text: "See attached",
        attachments: [{ name: "design.png", mimeType: "image/png", sizeBytes: 42 }],
        sourceTurnId: null,
        createdAt: "2026-09-14T19:00:00.000Z",
        updatedAt: "2026-09-14T19:00:00.000Z",
      }),
    ).toContain("design.png (image/png, 42 bytes)");
  });
});
