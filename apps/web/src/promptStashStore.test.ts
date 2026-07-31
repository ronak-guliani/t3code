import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SAVED_STASHES,
  partitionSavedStashAttachments,
  usePromptStashStore,
} from "./promptStashStore";

function entry(id: string) {
  return {
    id,
    createdAt: "2026-07-30T00:00:00.000Z",
    prompt: `prompt ${id}`,
    attachments: [],
    droppedImageNames: [],
  };
}

afterEach(() => {
  usePromptStashStore.setState({ entries: [] });
});

describe("promptStashStore", () => {
  it("keeps saved stashes newest first and takes them exactly once", () => {
    const store = usePromptStashStore.getState();
    store.stash(entry("first"));
    store.stash(entry("second"));

    expect(usePromptStashStore.getState().entries.map((value) => value.id)).toEqual([
      "second",
      "first",
    ]);
    expect(store.take("second").entry?.id).toBe("second");
    expect(store.take("second").entry).toBeNull();
  });

  it("evicts the oldest saved stash at the cap", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_SAVED_STASHES; index += 1) {
      store.stash(entry(String(index)));
    }

    expect(store.stash(entry("overflow")).evicted?.id).toBe("0");
    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_SAVED_STASHES);
  });

  it("preserves earlier attachments within the serialized attachment budget", () => {
    const { kept, droppedNames } = partitionSavedStashAttachments([
      {
        id: "small",
        name: "small.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "a",
      },
      {
        id: "large",
        name: "large.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "x".repeat(3_000_000),
      },
    ]);

    expect(kept.map((value) => value.name)).toEqual(["small.png"]);
    expect(droppedNames).toEqual(["large.png"]);
  });
});
