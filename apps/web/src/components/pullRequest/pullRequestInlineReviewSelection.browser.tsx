import { afterEach, describe, expect, it } from "vitest";

import { pullRequestInlineReviewSelection } from "./pullRequestInlineReviewSelection";

const containers: HTMLElement[] = [];

function selectDiffLine(line: number, lineType: string): HTMLElement {
  const container = document.createElement("section");
  const file = document.createElement("diffs-file");
  const shadowRoot = file.attachShadow({ mode: "open" });
  const diffLine = document.createElement("div");
  diffLine.dataset.line = String(line);
  diffLine.dataset.lineType = lineType;
  diffLine.textContent = "selected source code";
  shadowRoot.append(diffLine);
  container.append(file);
  document.body.append(container);
  containers.push(container);

  const range = document.createRange();
  range.selectNodeContents(diffLine);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return container;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const container of containers.splice(0)) container.remove();
});

describe("pullRequestInlineReviewSelection", () => {
  it("anchors added and context lines to the new file side", () => {
    const container = selectDiffLine(217, "change-addition");
    const selection = window.getSelection();

    expect(pullRequestInlineReviewSelection(selection, container)).toEqual({
      line: 217,
      side: "right",
    });

    const contextContainer = selectDiffLine(218, "context");
    expect(pullRequestInlineReviewSelection(selection, contextContainer)).toEqual({
      line: 218,
      side: "right",
    });
  });

  it("anchors deleted lines to the old file side", () => {
    const container = selectDiffLine(14, "change-deletion");

    expect(pullRequestInlineReviewSelection(window.getSelection(), container)).toEqual({
      line: 14,
      side: "left",
    });
  });

  it("ignores collapsed selections and selections from another file", () => {
    const container = selectDiffLine(14, "context");
    const selection = window.getSelection();
    selection?.removeAllRanges();

    expect(pullRequestInlineReviewSelection(selection, container)).toBeNull();

    const otherContainer = selectDiffLine(15, "context");
    expect(pullRequestInlineReviewSelection(selection, container)).toBeNull();
    expect(pullRequestInlineReviewSelection(selection, otherContainer)).toEqual({
      line: 15,
      side: "right",
    });
  });

  it("rejects selections whose range ends in another file", () => {
    const startContainer = selectDiffLine(14, "context");
    const endContainer = selectDiffLine(15, "context");
    const startNode = startContainer
      .querySelector("diffs-file")
      ?.shadowRoot?.querySelector("[data-line]")?.firstChild;
    const endNode = endContainer
      .querySelector("diffs-file")
      ?.shadowRoot?.querySelector("[data-line]")?.firstChild;
    if (!startNode || !endNode) throw new Error("Diff line fixture was not created.");

    const crossFileSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: startNode, endContainer: endNode }),
      toString: () => "selection across two files",
    };

    expect(pullRequestInlineReviewSelection(crossFileSelection, startContainer)).toBeNull();
  });
});
