import { assert, it } from "@effect/vitest";

import { servicePaths } from "../cloud/bootService.ts";
import { formatServiceStatus } from "./service.ts";

it("distinguishes installed definitions from a running service", () => {
  const paths = servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data", userId: 501 });
  const text = formatServiceStatus({
    ...paths,
    supported: true,
    platform: "darwin",
    installed: true,
    enabled: true,
    loaded: true,
    processAlive: false,
    responsive: false,
    current: true,
  });
  assert.include(text, "Installed: yes");
  assert.include(text, "Process: not running");
  assert.include(text, "Current: yes");
});

it("reports unsupported platforms explicitly", () => {
  assert.include(
    formatServiceStatus({
      ...servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data", userId: 0 }),
      supported: false,
      platform: "win32",
      installed: false,
      enabled: false,
      loaded: false,
      processAlive: false,
      responsive: false,
      current: false,
    }),
    "unsupported on win32",
  );
});
