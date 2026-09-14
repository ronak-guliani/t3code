import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  IsoDateTime,
  ModelSelection,
  OrchestrationMessageRole,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { Schema } from "effect";
import type { ProjectionChatArchiveEntry } from "./Services/ProjectionSnapshotQuery.ts";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_THREADS = 1_000;
const MAX_ARCHIVE_MESSAGES = 25_000;

const ArchivedAttachment = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
});

const ArchivedMessage = Schema.Struct({
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.Array(ArchivedAttachment),
  sourceTurnId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ArchivedThread = Schema.Struct({
  sourceThreadId: Schema.String,
  sourceParentThreadId: Schema.NullOr(Schema.String),
  sourceProjectTitle: Schema.String,
  sourceWorkspaceRoot: Schema.String,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messages: Schema.Array(ArchivedMessage),
});

export const ChatArchiveManifest = Schema.Struct({
  format: Schema.Literal("t3-chat-archive"),
  version: Schema.Literal(1),
  archiveId: Schema.String,
  title: Schema.String,
  exportedAt: IsoDateTime,
  threads: Schema.Array(ArchivedThread),
});
export type ChatArchiveManifest = typeof ChatArchiveManifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(ChatArchiveManifest));

function archiveTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
}

export function createChatArchiveManifest(input: {
  readonly threads: ReadonlyArray<ProjectionChatArchiveEntry>;
  readonly exportedAt: Date;
}): ChatArchiveManifest {
  return {
    format: "t3-chat-archive",
    version: 1,
    archiveId: randomUUID(),
    title: `Imported chats - ${input.exportedAt.toISOString().slice(0, 10)}`,
    exportedAt: input.exportedAt.toISOString(),
    threads: input.threads.map(({ thread, project }) => ({
      sourceThreadId: thread.id,
      sourceParentThreadId: thread.parentThreadId ?? null,
      sourceProjectTitle: project.title,
      sourceWorkspaceRoot: project.workspaceRoot,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages.map((message) => ({
        role: message.role,
        text: message.text,
        attachments: (message.attachments ?? []).map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
        sourceTurnId: message.turnId,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
    })),
  };
}

export async function writeChatArchive(
  exportDirectory: string,
  manifest: ChatArchiveManifest,
): Promise<string> {
  const serialized = JSON.stringify(manifest);
  validateArchiveLimits(manifest, Buffer.byteLength(serialized));
  const root = await realpath(exportDirectory);
  const name = `t3-chats-${archiveTimestamp(new Date(manifest.exportedAt))}-${manifest.archiveId.slice(0, 8)}`;
  const target = join(root, name);
  const stage = `${target}.partial`;
  await mkdir(stage, { mode: 0o700 });
  try {
    await writeFile(join(stage, "manifest.json"), serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(stage, target);
    return target;
  } catch (cause) {
    await rm(stage, { recursive: true, force: true });
    throw cause;
  }
}

export async function readChatArchive(path: string): Promise<ChatArchiveManifest> {
  const root = resolve(await realpath(dirname(resolve(path))), basename(resolve(path)));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Chat archive must be a real directory.");
  }
  const manifestPath = join(root, "manifest.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Chat archive manifest must be a regular file.");
  }
  if (info.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Chat archive is too large to import.");
  }
  const manifest = decodeManifest(await readFile(manifestPath, "utf8"));
  validateArchiveLimits(manifest, info.size);
  return manifest;
}

function validateArchiveLimits(manifest: ChatArchiveManifest, sizeBytes: number): void {
  if (sizeBytes > MAX_ARCHIVE_BYTES) {
    throw new Error("Chat archive is too large to import.");
  }
  if (manifest.threads.length === 0) {
    throw new Error("Chat archive contains no chats.");
  }
  if (manifest.threads.length > MAX_ARCHIVE_THREADS) {
    throw new Error(`Chat archive exceeds the ${MAX_ARCHIVE_THREADS} chat limit.`);
  }
  const messageCount = manifest.threads.reduce(
    (total, thread) => total + thread.messages.length,
    0,
  );
  if (messageCount > MAX_ARCHIVE_MESSAGES) {
    throw new Error(`Chat archive exceeds the ${MAX_ARCHIVE_MESSAGES} message limit.`);
  }
  const sourceIds = new Set(manifest.threads.map((thread) => thread.sourceThreadId));
  if (sourceIds.size !== manifest.threads.length) {
    throw new Error("Chat archive contains duplicate chat identifiers.");
  }
  if (
    manifest.threads.some(
      (thread) =>
        thread.sourceParentThreadId !== null && !sourceIds.has(thread.sourceParentThreadId),
    )
  ) {
    throw new Error("Chat archive contains an invalid chat hierarchy.");
  }
  const parentByThreadId = new Map(
    manifest.threads.map((thread) => [thread.sourceThreadId, thread.sourceParentThreadId] as const),
  );
  for (const thread of manifest.threads) {
    const visited = new Set<string>([thread.sourceThreadId]);
    let parentId = thread.sourceParentThreadId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new Error("Chat archive contains a cyclic chat hierarchy.");
      }
      visited.add(parentId);
      parentId = parentByThreadId.get(parentId) ?? null;
    }
  }
}

export function importedMessageText(
  message: ChatArchiveManifest["threads"][number]["messages"][number],
): string {
  if (message.attachments.length === 0) {
    return message.text;
  }
  const omitted = message.attachments
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    )
    .join("\n");
  return `${message.text}\n\n> Attachments were not included in this chat archive:\n${omitted}`;
}
