import { describe, expect, it } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  buildGitHubIssueReferenceUrl,
  parseCanonicalThreadPath,
  parseGitHubReferences,
  parseGitHubShorthandReferences,
  resolveExplicitThreadLink,
} from "./chatLinkClassification";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");

describe("resolveExplicitThreadLink", () => {
  it("recognizes a relative canonical thread path", () => {
    expect(
      resolveExplicitThreadLink("/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a", {
        baseOrigin: "https://app.example.test",
        trustedOrigins: [{ origin: "https://app.example.test" }],
      }),
    ).toEqual({
      ref: {
        environmentId: ENVIRONMENT_ID,
        threadId: "bc880b45-fd48-42db-98fa-f211bae7cc0a",
      },
      href: "/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a",
    });
  });

  it("recognizes a registered environment origin without trusting arbitrary route-shaped URLs", () => {
    expect(
      resolveExplicitThreadLink(
        "https://environment.example.test/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a",
        {
          baseOrigin: "https://app.example.test",
          trustedOrigins: [{ origin: "https://environment.example.test" }],
        },
      ),
    ).not.toBeNull();
    expect(
      resolveExplicitThreadLink(
        "https://untrusted.example.test/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a",
        {
          baseOrigin: "https://app.example.test",
          trustedOrigins: [{ origin: "https://environment.example.test" }],
        },
      ),
    ).toBeNull();
  });

  it("rejects cross-environment paths on a bound environment origin", () => {
    const threadId = "bc880b45-fd48-42db-98fa-f211bae7cc0a";
    expect(
      resolveExplicitThreadLink(`https://environment.example.test/environment-a/${threadId}`, {
        baseOrigin: "https://app.example.test",
        trustedOrigins: [
          { origin: "https://environment.example.test", environmentId: ENVIRONMENT_ID },
        ],
      }),
    ).not.toBeNull();
    expect(
      resolveExplicitThreadLink(`https://environment.example.test/environment-other/${threadId}`, {
        baseOrigin: "https://app.example.test",
        trustedOrigins: [
          { origin: "https://environment.example.test", environmentId: ENVIRONMENT_ID },
        ],
      }),
    ).toBeNull();
  });

  it.each(["http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773"])(
    "routes a stale local thread URL from %s to its registered environment",
    (origin) => {
      const threadId = "bc880b45-fd48-42db-98fa-f211bae7cc0a";
      expect(
        resolveExplicitThreadLink(`${origin}/environment-a/${threadId}`, {
          baseOrigin: "http://127.0.0.1:4773",
          trustedOrigins: [{ origin: "http://127.0.0.1:4773", environmentId: ENVIRONMENT_ID }],
        }),
      ).toEqual({
        ref: { environmentId: ENVIRONMENT_ID, threadId },
        href: `/environment-a/${threadId}`,
      });
    },
  );

  it.each([
    "http://localhost:3773/environment-other",
    "http://untrusted.example.test:3773/environment-a",
    "https://localhost:3773/environment-a",
    "http://localhost.evil.test:3773/environment-a",
    "http://user:password@localhost:3773/environment-a",
  ])("does not broaden local thread routing to %s", (prefix) => {
    expect(
      resolveExplicitThreadLink(`${prefix}/bc880b45-fd48-42db-98fa-f211bae7cc0a`, {
        baseOrigin: "http://127.0.0.1:4773",
        trustedOrigins: [{ origin: "http://127.0.0.1:4773", environmentId: ENVIRONMENT_ID }],
      }),
    ).toBeNull();
  });

  it("does not infer a local environment from an unbound app origin or remote registration", () => {
    for (const trustedOrigins of [
      [{ origin: "http://127.0.0.1:4773" }],
      [{ origin: "https://remote.example.test", environmentId: ENVIRONMENT_ID }],
      [{ origin: "file:///app", environmentId: ENVIRONMENT_ID }],
      [{ origin: "invalid", environmentId: ENVIRONMENT_ID }],
    ]) {
      expect(
        resolveExplicitThreadLink(
          "http://localhost:3773/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a",
          { baseOrigin: "http://127.0.0.1:4773", trustedOrigins },
        ),
      ).toBeNull();
    }
  });

  it("preserves a loopback origin's explicit environment binding", () => {
    expect(
      resolveExplicitThreadLink(
        "http://localhost:3773/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a",
        {
          baseOrigin: "http://localhost:4773",
          trustedOrigins: [
            {
              origin: "http://localhost:3773",
              environmentId: EnvironmentId.make("environment-other"),
            },
            { origin: "http://localhost:4773", environmentId: ENVIRONMENT_ID },
          ],
        },
      ),
    ).toBeNull();
  });

  it("rejects malformed and non-canonical paths", () => {
    expect(parseCanonicalThreadPath("/environment-a/not-a-thread", new Set([ENVIRONMENT_ID]))).toBe(
      null,
    );
    expect(
      parseCanonicalThreadPath("/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a/extra"),
    ).toBe(null);
  });

  it("returns null instead of throwing for whitespace-only environment segments", () => {
    const threadId = "bc880b45-fd48-42db-98fa-f211bae7cc0a";
    expect(parseCanonicalThreadPath(`/%20/${threadId}`)).toBe(null);
    expect(() =>
      resolveExplicitThreadLink(`/%20/${threadId}`, {
        baseOrigin: "https://app.example.test",
        trustedOrigins: [{ origin: "https://app.example.test" }],
      }),
    ).not.toThrow();
    expect(
      resolveExplicitThreadLink(`/%20/${threadId}`, {
        baseOrigin: "https://app.example.test",
        trustedOrigins: [{ origin: "https://app.example.test" }],
      }),
    ).toBeNull();
  });
});

describe("parseGitHubShorthandReferences", () => {
  it("parses qualified repository references without inventing bare repository context", () => {
    expect(parseGitHubShorthandReferences("See owner/repo#42 and #42.")).toEqual([
      { repository: "owner/repo", number: 42 },
    ]);
  });
});

describe("parseGitHubReferences", () => {
  it("keeps bare references separate from qualified repository identity", () => {
    expect(parseGitHubReferences("See owner/repo#42 and #43.")).toEqual([
      { repository: "owner/repo", number: 42 },
      { repository: null, number: 43 },
    ]);
  });

  it("builds an ambiguity-preserving GitHub issue destination", () => {
    expect(
      buildGitHubIssueReferenceUrl({
        repository: "owner/repo",
        number: 42,
      }),
    ).toBe("https://github.com/owner/repo/issues/42");
  });

  it("preserves the enterprise host for issue destinations", () => {
    expect(
      buildGitHubIssueReferenceUrl({
        repository: "owner/repo",
        number: 42,
        host: "github.example.com",
      }),
    ).toBe("https://github.example.com/owner/repo/issues/42");
  });
});
