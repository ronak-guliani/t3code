import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));

import ChatMarkdown, { githubRepositoryForProject } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it.each([
    `Thread bc880b45-fd48-42db-98fa-f211bae7cc0a`,
    "Created replacement thread: `bc880b45-fd48-42db-98fa-f211bae7cc0a`",
    "Thread BC880B45-FD48-42DB-98FA-F211BAE7CC0A",
  ])("renders thread references as internal links", (text) => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={text}
        cwd="/Users/julius/project"
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("current-thread"),
        )}
      />,
    );

    expect(markup).toContain("chat-markdown-thread-link");
    expect(markup).toContain('href="/environment-local/bc880b45-fd48-42db-98fa-f211bae7cc0a"');
    expect(markup).toContain("Open thread bc880b45-fd48-42db-98fa-f211bae7cc0a");
    expect(markup).not.toContain("BC880B45-FD48-42DB-98FA-F211BAE7CC0A");
  });

  it("does not link thread references without an environment context", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="Thread bc880b45-fd48-42db-98fa-f211bae7cc0a"
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).not.toContain("chat-markdown-thread-link");
  });

  it("keeps unrelated inline UUIDs as code", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="The generated value is `bc880b45-fd48-42db-98fa-f211bae7cc0a`."
        cwd="/Users/julius/project"
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("current-thread"),
        )}
      />,
    );

    expect(markup).not.toContain("chat-markdown-thread-link");
    expect(markup).toContain("<code>bc880b45-fd48-42db-98fa-f211bae7cc0a</code>");
  });

  it("classifies explicit canonical thread URLs before external links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="[new thread](/environment-other/bc880b45-fd48-42db-98fa-f211bae7cc0a)"
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("chat-markdown-thread-link");
    expect(markup).toContain('href="/environment-other/bc880b45-fd48-42db-98fa-f211bae7cc0a"');
    expect(markup).toContain("new thread");
    expect(markup).not.toContain('target="_blank"');
  });

  it("classifies reference-style canonical thread URLs before external links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={
          "[new thread][child]\n\n[child]: /environment-other/bc880b45-fd48-42db-98fa-f211bae7cc0a"
        }
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("chat-markdown-thread-link");
    expect(markup).toContain("new thread");
    expect(markup).not.toContain('target="_blank"');
  });

  it("classifies reference-style canonical pull request URLs", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"[pull request][pr]\n\n[pr]: https://github.com/owner/repo/pull/42"}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain('href="https://github.com/owner/repo/pull/42"');
    expect(markup).toContain('target="_blank"');
  });

  it("keeps qualified GitHub references clickable without fabricating a PR", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="See owner/repo#42 for the related change."
        cwd="/Users/julius/project"
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("current-thread"),
        )}
      />,
    );

    expect(markup).toContain('href="https://github.com/owner/repo/issues/42"');
    expect(markup).toContain("owner/repo#42");
    expect(markup).not.toContain("data-git-hub-pull-request-url");
  });

  it("links qualified GitHub references without a thread context", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text="See owner/repo#42 for the related change." cwd="/Users/julius/project" />,
    );

    expect(markup).toContain('href="https://github.com/owner/repo/issues/42"');
    expect(markup).toContain("owner/repo#42");
  });

  it("does not infer a repository for bare GitHub references", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="See #42 for the related change."
        cwd="/Users/julius/project"
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("current-thread"),
        )}
      />,
    );

    expect(markup).not.toContain('href="https://github.com/');
    expect(markup).toContain("#42");
  });

  it.each([
    {
      canonicalKey: "github/acme/repo",
      expected: { repository: "acme/repo", host: "github" },
    },
    {
      canonicalKey: "github.example.com/acme/repo",
      expected: { repository: "acme/repo", host: "github.example.com" },
    },
    {
      canonicalKey: "github.com/acme/repo",
      expected: { repository: "acme/repo", host: "github.com" },
    },
  ])("preserves the enterprise host from $canonicalKey", ({ canonicalKey, expected }) => {
    expect(
      githubRepositoryForProject({
        repositoryIdentity: {
          provider: "github",
          owner: "acme",
          name: "repo",
          canonicalKey,
        },
      }),
    ).toEqual(expected);
  });

  it("does not misread an owner as a host for owner/repo keys", () => {
    expect(
      githubRepositoryForProject({
        repositoryIdentity: {
          provider: "github",
          owner: "acme",
          name: "repo",
          canonicalKey: "acme/repo",
        },
      }),
    ).toEqual({ repository: "acme/repo", host: "github.com" });
  });

  it("does not trust route-shaped links on unrelated origins", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="[thread](https://example.com/environment-local/bc880b45-fd48-42db-98fa-f211bae7cc0a)"
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).not.toContain("chat-markdown-thread-link");
    expect(markup).toContain(
      'href="https://example.com/environment-local/bc880b45-fd48-42db-98fa-f211bae7cc0a"',
    );
  });

  it("removes leaked web citation tokens", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"Cancellation is expected. \uE200cite\uE202turn0search1\uE201"}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("Cancellation is expected.");
    expect(markup).not.toContain("turn0search1");
  });

  it("removes grouped leaked web citation tokens", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"Sources included. \uE200cite\uE202turn0search0\uE202turn0search1\uE201"}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("Sources included.");
    expect(markup).not.toContain("turn0search0");
    expect(markup).not.toContain("turn0search1");
  });

  it("hides trailing partial web citation tokens while streaming", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"Cancellation is expected. \uE200cite\uE202turn0search"}
        cwd="/Users/julius/project"
        isStreaming
      />,
    );

    expect(markup).toContain("Cancellation is expected.");
    expect(markup).not.toContain("cite");
    expect(markup).not.toContain("turn0search");
  });

  it("renders inline code file paths as file links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="Update `src/components/ChatMarkdown.tsx:42`."
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("chat-markdown-file-link");
    expect(markup).toContain("ChatMarkdown.tsx");
    expect(markup).toContain("L42");
  });

  it("leaves fenced code blocks and inline code in link labels unchanged", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"[Open `src/main.ts:1`](https://example.com)\n\n```\nsrc/main.ts:1\n```"}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).not.toContain("chat-markdown-file-link");
    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).toContain("<code>src/main.ts:1</code>");
  });

  it("disambiguates only rendered inline file links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"[Open `src/a/foo.ts`](https://example.com) and `src/b/foo.ts`."}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup.match(/href="\/Users\/julius\/project\/src\/b\/foo\.ts"/g)).toHaveLength(1);
    expect(markup).not.toContain("foo.ts · src/a");
    expect(markup).not.toContain("foo.ts · src/b");
  });
});
