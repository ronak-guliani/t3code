import * as Schema from "effect/Schema";

import { decodeIncomingShareDraft, type IncomingShareDraft } from "./incoming-share-model";

const INCOMING_SHARE_DIRECTORY = "incoming-shares";

export class IncomingShareStorageError extends Schema.TaggedErrorClass<IncomingShareStorageError>()(
  "IncomingShareStorageError",
  {
    operation: Schema.Literals(["load", "write", "remove"]),
    shareId: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Incoming share storage operation ${this.operation} failed for ${this.shareId ?? "unknown"}.`;
  }
}

function fileName(shareId: string): string {
  return `${encodeURIComponent(shareId)}.json`;
}

async function getDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, INCOMING_SHARE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getFile(shareId: string) {
  const { File } = await import("expo-file-system");
  return new File(await getDirectory(), fileName(shareId));
}

export async function loadIncomingShareDrafts(options?: {
  readonly strict?: boolean;
}): Promise<ReadonlyArray<IncomingShareDraft>> {
  try {
    const { File } = await import("expo-file-system");
    const entries = (await getDirectory())
      .list()
      .filter(
        (entry): entry is InstanceType<typeof File> =>
          entry instanceof File && entry.name.endsWith(".json"),
      );
    // Read independent share files concurrently instead of awaiting each
    // entry.text() sequentially in the loop (async-parallel).
    const decoded = await Promise.all(
      entries.map(async (entry) => {
        try {
          return {
            ok: true as const,
            draft: decodeIncomingShareDraft(JSON.parse(await entry.text()) as unknown),
          };
        } catch (cause) {
          return {
            ok: false as const,
            error: new IncomingShareStorageError({ operation: "load", shareId: null, cause }),
          };
        }
      }),
    );
    const drafts: IncomingShareDraft[] = [];
    for (const result of decoded) {
      if (result.ok) {
        drafts.push(result.draft);
      } else if (options?.strict) {
        throw result.error;
      } else {
        console.warn("[incoming-share] ignored invalid persisted share", result.error);
      }
    }
    return drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (cause) {
    if (cause instanceof IncomingShareStorageError) {
      throw cause;
    }
    throw new IncomingShareStorageError({ operation: "load", shareId: null, cause });
  }
}

export async function writeIncomingShareDraft(draft: IncomingShareDraft): Promise<void> {
  try {
    const file = await getFile(draft.id);
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(draft));
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "write", shareId: draft.id, cause });
  }
}

export async function removeIncomingShareDraft(shareId: string): Promise<void> {
  try {
    const file = await getFile(shareId);
    if (file.exists) {
      file.delete();
    }
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "remove", shareId, cause });
  }
}
