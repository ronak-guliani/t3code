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

  it("preserves Markdown autolinks instead of stripping them", () => {
    expect(toRenderablePullRequestMarkdown("See <https://example.com> for details")).toBe(
      "See [https://example.com](https://example.com) for details",
    );
    expect(toRenderablePullRequestMarkdown("Contact <user@example.com>")).toBe(
      "Contact [user@example.com](mailto:user@example.com)",
    );
    expect(
      toRenderablePullRequestMarkdown("See <HTTPS://example.com> and <ftp://example.com>"),
    ).toBe(
      "See [HTTPS://example.com](HTTPS://example.com) and [ftp://example.com](ftp://example.com)",
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
