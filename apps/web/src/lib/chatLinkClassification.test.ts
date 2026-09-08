import { describe, expect, it } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  parseCanonicalThreadPath,
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

  it("rejects malformed and non-canonical paths", () => {
    expect(parseCanonicalThreadPath("/environment-a/not-a-thread", new Set([ENVIRONMENT_ID]))).toBe(
      null,
    );
    expect(
      parseCanonicalThreadPath("/environment-a/bc880b45-fd48-42db-98fa-f211bae7cc0a/extra"),
    ).toBe(null);
  });
});

describe("parseGitHubShorthandReferences", () => {
  it("parses qualified repository references without inventing bare repository context", () => {
    expect(parseGitHubShorthandReferences("See owner/repo#42 and #42.")).toEqual([
      { repository: "owner/repo", number: 42 },
    ]);
  });
});
