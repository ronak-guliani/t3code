import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { desktopStatus } = vi.hoisted(() => ({
  desktopStatus: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: { automation: { status: desktopStatus } },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  applyPreviewDesktopState,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import {
  classifyPreviewPreflightTarget,
  readPreviewAutomationStatus,
} from "./PreviewAutomationHosts";
import { resolvePreviewAutomationTarget } from "./previewAutomationTarget";

afterEach(resetPreviewStateForTests);

it("returns a server tab ID that can target the next command after reading desktop status", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  const runtimeTabId = previewRuntimeTabId(threadRef, "server-epoch", "tab_1");
  reconcilePreviewServerSessions(threadRef, {
    serverEpoch: "server-epoch",
    revision: 1,
    sessions: [
      {
        tabId: "tab_1",
        threadId: threadRef.threadId,
        navStatus: { _tag: "Success", url: "http://localhost:5733", title: "Test app" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: new Date(0).toISOString(),
      },
    ],
  });

  applyPreviewDesktopState(threadRef, "tab_1", {
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    controller: "none",
  });
  desktopStatus.mockResolvedValue({
    available: true,
    tabId: runtimeTabId,
    url: "http://localhost:5733",
    title: "Test app",
    loading: false,
  });
  const result = await readPreviewAutomationStatus(threadRef, "tab_1");
  expect(desktopStatus).toHaveBeenCalledWith(runtimeTabId);
  expect(result.tabId).toBe("tab_1");
  expect(
    resolvePreviewAutomationTarget(readThreadPreviewState(threadRef), result.tabId).tabId,
  ).toBe("tab_1");
});

it.each([
  {
    name: "missing app target",
    descriptorStatus: 200,
    appStatus: 503,
    environmentId: null,
    app: "not-configured",
    recovery: "configure-target",
  },
  {
    name: "non-T3 target",
    descriptorStatus: 200,
    appStatus: 200,
    environmentId: null,
    app: "not-t3-app",
    recovery: "configure-target",
  },
  {
    name: "environment mismatch",
    descriptorStatus: 200,
    appStatus: 200,
    environmentId: EnvironmentId.make("other-environment"),
    app: "expected-t3-app",
    recovery: "resolve-environment-mismatch",
  },
  {
    name: "healthy target",
    descriptorStatus: 200,
    appStatus: 200,
    environmentId: EnvironmentId.make("environment"),
    app: "expected-t3-app",
    recovery: "pair-after-preflight",
  },
] as const)("classifies $name without exposing pairing URL data", (scenario) => {
  const result = classifyPreviewPreflightTarget({
    descriptorStatus: scenario.descriptorStatus,
    appStatus: scenario.appStatus,
    origin: "http://localhost:5733",
    environmentId: scenario.environmentId,
    expectedEnvironmentId: EnvironmentId.make("environment"),
  });
  expect(result.target.app).toBe(scenario.app);
  expect(result.recovery.kind).toBe(scenario.recovery);
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

it("classifies an unreachable target with retry-target recovery", () => {
  const result = classifyPreviewPreflightTarget({
    descriptorStatus: null,
    appStatus: null,
    origin: "http://localhost:5733",
    environmentId: null,
    expectedEnvironmentId: EnvironmentId.make("environment"),
  });
  expect(result).toMatchObject({
    target: { reachability: "unreachable", app: "unknown" },
    recovery: { kind: "retry-target" },
  });
});

it("accepts an isolated target when no expected target identity was supplied", () => {
  const result = classifyPreviewPreflightTarget({
    descriptorStatus: 200,
    appStatus: 200,
    origin: "http://localhost:5733",
    environmentId: EnvironmentId.make("isolated-target"),
    expectedEnvironmentId: null,
  });
  expect(result.recovery.kind).toBe("pair-after-preflight");
});
