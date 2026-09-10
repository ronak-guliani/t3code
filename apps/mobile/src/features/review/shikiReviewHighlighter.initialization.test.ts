import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const shikiMocks = vi.hoisted(() => ({
  evaluations: {
    core: 0,
    javascriptEngine: 0,
    nativeEngine: 0,
    languages: 0,
    themes: 0,
  },
  createCalls: 0,
  javascriptEngineCalls: 0,
  nativeEngineCalls: 0,
  nativeAvailable: true,
  nativeCreateError: null as Error | null,
  createFailuresRemaining: 0,
  createGate: null as Promise<void> | null,
  reset() {
    this.evaluations.core = 0;
    this.evaluations.javascriptEngine = 0;
    this.evaluations.nativeEngine = 0;
    this.evaluations.languages = 0;
    this.evaluations.themes = 0;
    this.createCalls = 0;
    this.javascriptEngineCalls = 0;
    this.nativeEngineCalls = 0;
    this.nativeAvailable = true;
    this.nativeCreateError = null;
    this.createFailuresRemaining = 0;
    this.createGate = null;
  },
}));

vi.mock("@shikijs/core", () => {
  shikiMocks.evaluations.core += 1;
  return {
    createHighlighterCore: async () => {
      shikiMocks.createCalls += 1;
      if (shikiMocks.createGate) {
        await shikiMocks.createGate;
      }
      if (shikiMocks.createFailuresRemaining > 0) {
        shikiMocks.createFailuresRemaining -= 1;
        throw new Error("highlighter initialization failed");
      }
      return {};
    },
  };
});

vi.mock("@shikijs/engine-javascript", () => {
  shikiMocks.evaluations.javascriptEngine += 1;
  return {
    createJavaScriptRegexEngine: () => {
      shikiMocks.javascriptEngineCalls += 1;
      return { kind: "javascript" };
    },
  };
});

vi.mock("react-native-shiki-engine", () => {
  shikiMocks.evaluations.nativeEngine += 1;
  return {
    isNativeEngineAvailable: () => shikiMocks.nativeAvailable,
    createNativeEngine: () => {
      shikiMocks.nativeEngineCalls += 1;
      if (shikiMocks.nativeCreateError) {
        throw shikiMocks.nativeCreateError;
      }
      return { kind: "native" };
    },
  };
});

vi.mock("@shikijs/langs/bash", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "bash" } };
});
vi.mock("@shikijs/langs/javascript", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "javascript" } };
});
vi.mock("@shikijs/langs/json", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "json" } };
});
vi.mock("@shikijs/langs/jsx", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "jsx" } };
});
vi.mock("@shikijs/langs/tsx", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "tsx" } };
});
vi.mock("@shikijs/langs/typescript", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "typescript" } };
});
vi.mock("@shikijs/langs/yaml", () => {
  shikiMocks.evaluations.languages += 1;
  return { default: { name: "yaml" } };
});
vi.mock("@shikijs/themes/github-dark-default", () => {
  shikiMocks.evaluations.themes += 1;
  return { default: { name: "github-dark-default" } };
});
vi.mock("@shikijs/themes/github-light-default", () => {
  shikiMocks.evaluations.themes += 1;
  return { default: { name: "github-light-default" } };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  shikiMocks.reset();
});

describe("review highlighter initialization", () => {
  it("does not evaluate Shiki runtime modules when importing the facade", async () => {
    await import("./shikiReviewHighlighter");

    expect(shikiMocks.evaluations).toEqual({
      core: 0,
      javascriptEngine: 0,
      nativeEngine: 0,
      languages: 0,
      themes: 0,
    });
  });

  it("deduplicates concurrent initialization", async () => {
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "javascript");
    const gate = Promise.withResolvers<void>();
    shikiMocks.createGate = gate.promise;
    const highlighter = await import("./shikiReviewHighlighter");

    const first = highlighter.prepareReviewHighlighter();
    const second = highlighter.prepareReviewHighlighter();
    await vi.waitFor(() => expect(shikiMocks.createCalls).toBe(1));
    gate.resolve();
    await Promise.all([first, second]);

    expect(shikiMocks.createCalls).toBe(1);
    expect(shikiMocks.javascriptEngineCalls).toBe(1);
  });

  it("does not load the JavaScript engine when native initialization succeeds", async () => {
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "native");
    const highlighter = await import("./shikiReviewHighlighter");

    await highlighter.prepareReviewHighlighter();

    expect(await highlighter.getActiveReviewHighlighterEngine()).toBe("native");
    expect(shikiMocks.evaluations.javascriptEngine).toBe(0);
    expect(shikiMocks.javascriptEngineCalls).toBe(0);
    expect(shikiMocks.nativeEngineCalls).toBe(1);
  });

  it("loads the JavaScript engine only after native initialization fails", async () => {
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "native");
    shikiMocks.nativeCreateError = new Error("native engine failed");
    const highlighter = await import("./shikiReviewHighlighter");

    await highlighter.prepareReviewHighlighter();

    expect(await highlighter.getActiveReviewHighlighterEngine()).toBe("javascript");
    expect(shikiMocks.javascriptEngineCalls).toBe(1);
  });

  it("retries after a failed initialization", async () => {
    vi.stubEnv("EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE", "javascript");
    shikiMocks.createFailuresRemaining = 1;
    const highlighter = await import("./shikiReviewHighlighter");

    await expect(highlighter.prepareReviewHighlighter()).rejects.toThrow(
      "Failed to initialize the javascript review highlighter",
    );
    await expect(highlighter.prepareReviewHighlighter()).resolves.toBeUndefined();

    expect(shikiMocks.createCalls).toBe(2);
    expect(shikiMocks.javascriptEngineCalls).toBe(2);
  });
});
