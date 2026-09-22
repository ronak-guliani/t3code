import { describe, expect, it } from "vitest";

import { splitPullRequestBody } from "./pullRequestMedia";

describe("splitPullRequestBody", () => {
  it("keeps markdown around GitHub video attachments", () => {
    expect(
      splitPullRequestBody("Before\nhttps://github.com/user-attachments/assets/video-id\nAfter"),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before" },
      {
        id: "video:1",
        kind: "video",
        url: "https://github.com/user-attachments/assets/video-id",
      },
      { id: "markdown:2", kind: "markdown", text: "After" },
    ]);
  });

  it("extracts standalone video tags without interpreting fenced code", () => {
    expect(
      splitPullRequestBody(
        [
          "```html",
          '<video src="https://example.com/code.mp4"></video>',
          "```",
          "<video controls>",
          '  <source src="https://example.com/demo.webm">',
          "</video>",
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "markdown:0",
        kind: "markdown",
        text: '```html\n<video src="https://example.com/code.mp4"></video>\n```',
      },
      { id: "video:1", kind: "video", url: "https://example.com/demo.webm" },
    ]);
  });

  it("leaves unsafe and inline video tags as markdown", () => {
    expect(
      splitPullRequestBody(
        'See <video src="https://example.com/demo.mp4"></video>\n<video src="javascript:alert(1)"></video>',
      ),
    ).toEqual([
      {
        id: "markdown:0",
        kind: "markdown",
        text: 'See <video src="https://example.com/demo.mp4"></video>\n<video src="javascript:alert(1)"></video>',
      },
    ]);
  });
});
