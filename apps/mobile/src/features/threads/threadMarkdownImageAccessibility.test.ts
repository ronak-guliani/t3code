import { describe, expect, it } from "vite-plus/test";

import { deriveMarkdownImagePlaceholderAccessibility } from "./threadMarkdownImageAccessibility";

describe("deriveMarkdownImagePlaceholderAccessibility", () => {
  it("exposes a failed retryable image as a retry button", () => {
    expect(
      deriveMarkdownImagePlaceholderAccessibility({
        alt: "Architecture diagram",
        failed: true,
        canRetry: true,
        hasMediaActions: true,
      }),
    ).toEqual({
      role: "button",
      label: "Architecture diagram unavailable. Retry",
      hint: "Double tap to retry loading this image",
    });
  });

  it("keeps an unavailable image actionable when media actions remain", () => {
    expect(
      deriveMarkdownImagePlaceholderAccessibility({
        alt: "Architecture diagram",
        failed: true,
        canRetry: false,
        hasMediaActions: true,
      }),
    ).toEqual({
      role: "imagebutton",
      label: "Architecture diagram unavailable",
      hint: "Touch and hold for media actions",
    });
  });

  it("uses static image semantics when no actions are available", () => {
    expect(
      deriveMarkdownImagePlaceholderAccessibility({
        alt: null,
        failed: true,
        canRetry: false,
        hasMediaActions: false,
      }),
    ).toEqual({
      role: "image",
      label: "Image unavailable",
      hint: undefined,
    });
  });
});
