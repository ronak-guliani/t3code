import { describe, expect, it } from "vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildThreadUrl } from "./threadUrl.ts";

describe("buildThreadUrl", () => {
  it("uses and normalizes the active production app origin", () => {
    expect(
      buildThreadUrl({
        appOrigin: "https://code.example.test/app?stale=1#old",
        environmentId: EnvironmentId.make("environment prod"),
        threadId: ThreadId.make("child/one"),
      }),
    ).toBe("https://code.example.test/environment%20prod/child%2Fone");
  });

  it("uses a development app origin without hard-coded deployment hosts", () => {
    expect(
      buildThreadUrl({
        appOrigin: new URL("http://127.0.0.1:5173"),
        environmentId: EnvironmentId.make("dev"),
        threadId: ThreadId.make("thread?draft"),
      }),
    ).toBe("http://127.0.0.1:5173/dev/thread%3Fdraft");
  });
});
