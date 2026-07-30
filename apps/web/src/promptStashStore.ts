import * as Schema from "effect/Schema";
import { create } from "zustand";

import { type PersistedComposerImageAttachment } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
export const MAX_SAVED_STASHES = 20;
export const MAX_SAVED_STASH_ATTACHMENT_CHARS = 2_700_000;

const PromptStashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Finite,
      dataUrl: Schema.String,
    }),
  ),
  droppedImageNames: Schema.Array(Schema.String),
});
export type PromptStashEntry = typeof PromptStashEntrySchema.Type;

const PersistedPromptStashSchema = Schema.Struct({
  entries: Schema.Array(PromptStashEntrySchema),
});
const decodePersistedPromptStash = Schema.decodeUnknownSync(PersistedPromptStashSchema);

function resolveStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // A blocked storage policy still permits an in-memory stash for this session.
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage, durable: storageIsDurable } = resolveStorage();

function loadEntries(): PromptStashEntry[] {
  try {
    const raw = storage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return [];
    return [...decodePersistedPromptStash(JSON.parse(raw)).entries];
  } catch {
    return [];
  }
}

function persistEntries(entries: ReadonlyArray<PromptStashEntry>): {
  written: boolean;
  durable: boolean;
} {
  try {
    storage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify({ entries }));
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist saved stashes.", error);
    return { written: false, durable: false };
  }
}

export function partitionSavedStashAttachments(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): { kept: PersistedComposerImageAttachment[]; droppedNames: string[] } {
  const kept: PersistedComposerImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_SAVED_STASH_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

interface PromptStashStore {
  entries: ReadonlyArray<PromptStashEntry>;
  stash: (entry: PromptStashEntry) => {
    written: boolean;
    durable: boolean;
    evicted: PromptStashEntry | null;
  };
  take: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStore>()((set, get) => ({
  entries: loadEntries(),
  stash: (entry) => {
    const nextEntries = [entry, ...get().entries];
    const evicted = nextEntries.length > MAX_SAVED_STASHES ? (nextEntries.pop() ?? null) : null;
    const result = persistEntries(nextEntries);
    if (!result.written) {
      return { ...result, evicted: null };
    }
    set({ entries: nextEntries });
    return { ...result, evicted };
  },
  take: (entryId) => {
    const entry = get().entries.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextEntries = get().entries.filter((candidate) => candidate.id !== entryId);
    const { written, durable } = persistEntries(nextEntries);
    if (written) {
      set({ entries: nextEntries });
    }
    return { entry: written ? entry : null, durable };
  },
}));
