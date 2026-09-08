import type { AccessibilityRole } from "react-native";

export interface MarkdownImagePlaceholderAccessibility {
  readonly role: AccessibilityRole;
  readonly label: string;
  readonly hint?: string;
}

export function deriveMarkdownImagePlaceholderAccessibility(input: {
  readonly alt: string | null;
  readonly failed: boolean;
  readonly canRetry: boolean;
  readonly hasMediaActions: boolean;
}): MarkdownImagePlaceholderAccessibility {
  const imageLabel = input.alt ?? "Image";

  if (input.canRetry) {
    return {
      role: "button",
      label: `${imageLabel} unavailable. Retry`,
      hint: "Double tap to retry loading this image",
    };
  }

  return {
    role: input.hasMediaActions ? "imagebutton" : "image",
    label: input.failed ? `${imageLabel} unavailable` : (input.alt ?? "Markdown image"),
    hint: input.hasMediaActions ? "Touch and hold for media actions" : undefined,
  };
}
