import { describe, expect, it } from "vitest";

import { toRenderablePullRequestMarkdown } from "./pullRequestPresentation";

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
});
