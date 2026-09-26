import { describe, expect, it } from "vitest";

import {
  pullRequestReviewVerdictPresentation,
  resolvePullRequestMergeSelection,
  summarizePullRequestChecks,
  toRenderablePullRequestMarkdown,
} from "./pullRequestPresentation";

describe("toRenderablePullRequestMarkdown", () => {
  it("converts attributed details and summary elements", () => {
    expect(
      toRenderablePullRequestMarkdown(
        "Before<details open><summary><strong>More info</strong></summary>Hidden<br>text</details>After",
      ),
    ).toBe("Before\n\n### More info\n\nHidden\ntext\n\nAfter");
  });

  it("converts links with either quote style", () => {
    expect(
      toRenderablePullRequestMarkdown(
        `<a class="external" href='https://example.com/a_(b)'>Read [this]</a>`,
      ),
    ).toBe("[Read \\[this\\]](https://example.com/a_\\(b\\))");
  });

  it("converts GitHub image tags into renderable Markdown images", () => {
    expect(
      toRenderablePullRequestMarkdown(
        '<img src="https://github.com/user-attachments/assets/image-id" alt="Before [after]">',
      ),
    ).toBe("![Before \\[after\\]](https://github.com/user-attachments/assets/image-id)");
  });

  it("preserves greater-than characters inside quoted image alt text", () => {
    expect(
      toRenderablePullRequestMarkdown(
        '<img src="https://github.com/user-attachments/assets/image-id" alt="before > after">',
      ),
    ).toBe("![before > after](https://github.com/user-attachments/assets/image-id)");
  });

  it("decodes supported HTML entities after removing tags", () => {
    expect(toRenderablePullRequestMarkdown("<p>Tom &amp; &quot;Jerry&quot;</p>")).toBe(
      'Tom & "Jerry"',
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const body =
      'See:\n```html\n<details><summary>Hi</summary></details>\n```\n<a href="https://example.com">Done</a>';
    expect(toRenderablePullRequestMarkdown(body)).toBe(
      "See:\n```html\n<details><summary>Hi</summary></details>\n```\n[Done](https://example.com)",
    );
  });

  it("leaves tilde fenced code blocks untouched", () => {
    const body =
      'See:\n~~~html\n<details><summary>Hi</summary></details>\n~~~\n<a href="https://example.com">Done</a>';
    expect(toRenderablePullRequestMarkdown(body)).toBe(
      "See:\n~~~html\n<details><summary>Hi</summary></details>\n~~~\n[Done](https://example.com)",
    );
  });

  it("does not close a long tilde fence with a shorter run", () => {
    const body =
      '~~~~html\n<details><summary>Hi</summary></details>\n~~~\n<a href="https://example.com">Still code</a>\n~~~~\n<a href="https://example.com">Done</a>';
    expect(toRenderablePullRequestMarkdown(body)).toBe(
      '~~~~html\n<details><summary>Hi</summary></details>\n~~~\n<a href="https://example.com">Still code</a>\n~~~~\n[Done](https://example.com)',
    );
  });

  it("preserves CRLF fenced code blocks", () => {
    const body =
      '```html\r\n<details><summary>Hi</summary></details>\r\n```\r\n<a href="https://example.com">Done</a>';
    expect(toRenderablePullRequestMarkdown(body)).toBe(
      "```html\r\n<details><summary>Hi</summary></details>\r\n```\r\n[Done](https://example.com)",
    );
  });

  it("preserves Markdown autolinks instead of stripping them", () => {
    expect(toRenderablePullRequestMarkdown("See <https://example.com> for details")).toBe(
      "See [https://example.com](https://example.com) for details",
    );
    expect(toRenderablePullRequestMarkdown("Contact <user@example.com>")).toBe(
      "Contact [user@example.com](mailto:user@example.com)",
    );
    expect(
      toRenderablePullRequestMarkdown("See <HTTPS://example.com> and <ftp://user@example.com>"),
    ).toBe(
      "See [HTTPS://example.com](HTTPS://example.com) and [ftp://user@example.com](ftp://user@example.com)",
    );
  });

  it("leaves inline code spans untouched", () => {
    expect(toRenderablePullRequestMarkdown("Use `<details>` here")).toBe("Use `<details>` here");
  });

  it("leaves multi-backtick code spans untouched", () => {
    expect(toRenderablePullRequestMarkdown("See `` <details> `` done")).toBe(
      "See `` <details> `` done",
    );
  });
});

describe("pullRequestReviewVerdictPresentation", () => {
  it("badges verdicts and leaves plain reviews unbadged", () => {
    expect(pullRequestReviewVerdictPresentation("APPROVED")).toEqual({
      label: "Approved",
      variant: "success",
    });
    expect(pullRequestReviewVerdictPresentation("approved")).toEqual({
      label: "Approved",
      variant: "success",
    });
    expect(pullRequestReviewVerdictPresentation("CHANGES_REQUESTED")).toEqual({
      label: "Changes requested",
      variant: "error",
    });
    expect(pullRequestReviewVerdictPresentation("DISMISSED")).toEqual({
      label: "Review dismissed",
      variant: "outline",
    });
    expect(pullRequestReviewVerdictPresentation("COMMENTED")).toEqual({
      label: "Review",
      variant: null,
    });
    expect(pullRequestReviewVerdictPresentation(null)).toEqual({
      label: "Review",
      variant: null,
    });
  });
});

describe("summarizePullRequestChecks", () => {
  it("buckets statuses with server readiness semantics", () => {
    expect(
      summarizePullRequestChecks([
        { status: "success" },
        { status: "neutral" },
        { status: "skipped" },
        { status: "pending" },
        { status: "cancelled" },
        { status: "failure" },
      ]),
    ).toEqual({ passing: 3, failing: 1, pending: 1, cancelled: 1, total: 6 });
  });
});

describe("resolvePullRequestMergeSelection", () => {
  it("offers only host-allowed methods and defaults to the first one", () => {
    expect(
      resolvePullRequestMergeSelection({
        canMerge: true,
        mergeMethods: ["merge", "squash", "rebase"],
        mergeCapabilities: { merge: true, squash: true, rebase: false },
        override: null,
      }),
    ).toEqual({
      allowedMergeMethods: ["merge", "squash"],
      selectedMergeMethod: "merge",
      showMergeMethodPicker: true,
    });
  });

  it("honors a still-allowed override and drops one that is no longer allowed", () => {
    const base = {
      canMerge: true,
      mergeMethods: ["merge", "squash", "rebase"] as const,
      mergeCapabilities: { merge: true, squash: true, rebase: false },
    };
    expect(
      resolvePullRequestMergeSelection({ ...base, override: "squash" }).selectedMergeMethod,
    ).toBe("squash");
    expect(
      resolvePullRequestMergeSelection({ ...base, override: "rebase" }).selectedMergeMethod,
    ).toBe("merge");
  });

  it("hides the picker without merge permission or without a real choice", () => {
    expect(
      resolvePullRequestMergeSelection({
        canMerge: false,
        mergeMethods: ["merge", "squash"],
        mergeCapabilities: { merge: true, squash: true, rebase: false },
        override: null,
      }).showMergeMethodPicker,
    ).toBe(false);
    expect(
      resolvePullRequestMergeSelection({
        canMerge: true,
        mergeMethods: ["merge", "squash"],
        mergeCapabilities: { merge: true, squash: false, rebase: false },
        override: null,
      }),
    ).toEqual({
      allowedMergeMethods: ["merge"],
      selectedMergeMethod: "merge",
      showMergeMethodPicker: false,
    });
    expect(
      resolvePullRequestMergeSelection({
        canMerge: true,
        mergeMethods: ["merge"],
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        override: null,
      }),
    ).toEqual({ allowedMergeMethods: [], selectedMergeMethod: null, showMergeMethodPicker: false });
  });
});
