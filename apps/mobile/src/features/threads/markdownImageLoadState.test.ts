import { describe, expect, it } from "vite-plus/test";

import {
  createMarkdownImageLoadState,
  MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES,
  reduceMarkdownImageLoadState,
  shouldAutomaticallyRetryMarkdownImage,
} from "./markdownImageLoadState";

describe("markdown image load recovery", () => {
  it("retries a failed same-URL request and clears the failure after success", () => {
    const initial = createMarkdownImageLoadState({
      sourceKey: "https://example.test/image.png",
      uri: "https://example.test/image.png",
    });
    const failed = reduceMarkdownImageLoadState(initial, {
      type: "failed",
      uri: initial.uri!,
    });

    expect(
      shouldAutomaticallyRetryMarkdownImage(failed, {
        uri: initial.uri,
        unavailable: false,
      }),
    ).toBe(true);

    const retried = reduceMarkdownImageLoadState(failed, {
      type: "retry",
      automatic: true,
    });
    const loaded = reduceMarkdownImageLoadState(retried, {
      type: "loaded",
      uri: initial.uri!,
    });

    expect(retried.requestVersion).toBe(1);
    expect(loaded.failed).toBe(false);
    expect(loaded.automaticRetryCount).toBe(0);
  });

  it("bounds automatic retries for a persistently invalid URL", () => {
    let state = createMarkdownImageLoadState({
      sourceKey: "https://example.test/missing.png",
      uri: "https://example.test/missing.png",
    });

    for (let attempt = 0; attempt < MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES; attempt += 1) {
      state = reduceMarkdownImageLoadState(state, { type: "failed", uri: state.uri! });
      expect(
        shouldAutomaticallyRetryMarkdownImage(state, {
          uri: state.uri,
          unavailable: false,
        }),
      ).toBe(true);
      state = reduceMarkdownImageLoadState(state, { type: "retry", automatic: true });
    }

    state = reduceMarkdownImageLoadState(state, { type: "failed", uri: state.uri! });
    expect(state.failed).toBe(true);
    expect(
      shouldAutomaticallyRetryMarkdownImage(state, {
        uri: state.uri,
        unavailable: false,
      }),
    ).toBe(false);
  });

  it("ignores stale callbacks after the source changes and resets the retry cycle", () => {
    const first = createMarkdownImageLoadState({
      sourceKey: "first",
      uri: "https://example.test/first.png",
    });
    const second = reduceMarkdownImageLoadState(first, {
      type: "source-changed",
      sourceKey: "second",
      uri: "https://example.test/second.png",
    });
    const staleFailure = reduceMarkdownImageLoadState(second, {
      type: "failed",
      uri: "https://example.test/first.png",
    });

    expect(staleFailure).toEqual(second);
    expect(second.automaticRetryCount).toBe(0);
    expect(second.failed).toBe(false);
  });

  it("allows an explicit retry to start a fresh bounded cycle", () => {
    const state = createMarkdownImageLoadState({
      sourceKey: "https://example.test/image.png",
      uri: "https://example.test/image.png",
    });
    const exhausted = {
      ...state,
      failed: true,
      automaticRetryCount: MAX_AUTOMATIC_MARKDOWN_IMAGE_RETRIES,
    };
    const retried = reduceMarkdownImageLoadState(exhausted, {
      type: "retry",
      automatic: false,
    });

    expect(retried.failed).toBe(false);
    expect(retried.automaticRetryCount).toBe(0);
    expect(retried.requestVersion).toBe(1);
  });
});
