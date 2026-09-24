import type { PullRequestDiffSide } from "@t3tools/contracts";

export interface PullRequestInlineReviewSelection {
  readonly line: number;
  readonly side: PullRequestDiffSide;
}

export function pullRequestInlineReviewSelection(
  selection: Selection | null,
  fileContainer: HTMLElement,
): PullRequestInlineReviewSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (selection.toString().trim().length === 0) return null;

  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const lineElement = startElement?.closest<HTMLElement>("[data-line][data-line-type]");
  if (!lineElement) return null;

  const root = lineElement.getRootNode();
  if (!(root instanceof ShadowRoot) || !fileContainer.contains(root.host)) return null;

  const line = Number(lineElement.dataset.line);
  if (!Number.isSafeInteger(line) || line < 1) return null;

  return {
    line,
    side: lineElement.dataset.lineType === "change-deletion" ? "left" : "right",
  };
}
