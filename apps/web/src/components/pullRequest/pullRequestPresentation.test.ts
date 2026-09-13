import { describe, expect, it } from "vitest";

import {
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

  it("leaves inline code spans untouched", () => {
    expect(toRenderablePullRequestMarkdown("Use `<details>` here")).toBe("Use `<details>` here");
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
