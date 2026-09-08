import { describe, expect, it } from "vite-plus/test";

import {
  createMarkdownImageLoadState,
  createMarkdownImageRequestKey,
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
      request: {
        sourceKey: initial.sourceKey,
        uri: initial.uri!,
        requestVersion: initial.requestVersion,
      },
    });

    expect(
      shouldAutomaticallyRetryMarkdownImage(failed, {
        sourceKey: initial.sourceKey,
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
      request: {
        sourceKey: initial.sourceKey,
        uri: initial.uri!,
        requestVersion: retried.requestVersion,
      },
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
      state = reduceMarkdownImageLoadState(state, {
        type: "failed",
        request: {
          sourceKey: state.sourceKey,
          uri: state.uri!,
          requestVersion: state.requestVersion,
        },
      });
      expect(
        shouldAutomaticallyRetryMarkdownImage(state, {
          sourceKey: state.sourceKey,
          uri: state.uri,
          unavailable: false,
        }),
      ).toBe(true);
      state = reduceMarkdownImageLoadState(state, { type: "retry", automatic: true });
    }

    state = reduceMarkdownImageLoadState(state, {
      type: "failed",
      request: {
        sourceKey: state.sourceKey,
        uri: state.uri!,
        requestVersion: state.requestVersion,
      },
    });
    expect(state.failed).toBe(true);
    expect(
      shouldAutomaticallyRetryMarkdownImage(state, {
        sourceKey: state.sourceKey,
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
      request: {
        sourceKey: "first",
        uri: "https://example.test/first.png",
        requestVersion: first.requestVersion,
      },
    });

    expect(staleFailure).toEqual(second);
    expect(second.automaticRetryCount).toBe(0);
    expect(second.failed).toBe(false);
  });

  it("ignores stale same-URL callbacks from a superseded request version", () => {
    const initial = createMarkdownImageLoadState({
      sourceKey: "same-source",
      uri: "https://example.test/image.png",
    });
    const retried = reduceMarkdownImageLoadState(initial, {
      type: "retry",
      automatic: true,
    });
    const staleRequest = {
      sourceKey: initial.sourceKey,
      uri: initial.uri!,
      requestVersion: initial.requestVersion,
    };

    expect(
      reduceMarkdownImageLoadState(retried, { type: "loaded", request: staleRequest }),
    ).toEqual(retried);
    expect(
      reduceMarkdownImageLoadState(retried, { type: "failed", request: staleRequest }),
    ).toEqual(retried);
  });

  it("does not retry a failed request after a same-URL source replacement", () => {
    const failed = {
      ...createMarkdownImageLoadState({
        sourceKey: "first",
        uri: "https://example.test/image.png",
      }),
      failed: true,
    };

    expect(
      shouldAutomaticallyRetryMarkdownImage(failed, {
        sourceKey: "second",
        uri: failed.uri,
        unavailable: false,
      }),
    ).toBe(false);
  });

  it("remounts the native request when source identity changes at the same URL", () => {
    expect(
      createMarkdownImageRequestKey({
        sourceKey: "attachment:first",
        uri: "https://example.test/image.png",
        requestVersion: 0,
      }),
    ).not.toBe(
      createMarkdownImageRequestKey({
        sourceKey: "attachment:second",
        uri: "https://example.test/image.png",
        requestVersion: 0,
      }),
    );
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
