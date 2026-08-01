import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

it("distinguishes installed definitions from a running service", () => {
  const text = formatServiceStatus({
    supported: true,
    platform: "darwin",
    installed: true,
    enabled: true,
    running: false,
    current: true,
    definitionPath: "/Users/me/Library/LaunchAgents/com.t3tools.t3code.server.plist",
    logPath: "/Users/me/.t3/runtime/background-service/service.log",
  });
  assert.include(text, "Installed: yes");
  assert.include(text, "Running: no");
  assert.include(text, "Current: yes");
});

it("reports unsupported platforms explicitly", () => {
  assert.include(
    formatServiceStatus({
      supported: false,
      platform: "win32",
      installed: false,
      enabled: false,
      running: false,
      current: false,
      definitionPath: "",
      logPath: "",
    }),
    "unsupported on win32",
  );
});
