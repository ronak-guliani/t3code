import {
  type PreviewAutomationNavigateInput,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isNetworkIdleSample,
  NETWORK_IDLE_SAMPLE_EXPRESSION,
  resolveNetworkIdleQuietMs,
} from "@t3tools/shared/previewNetworkIdle";

import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";

export function assertPreviewRuntimeCurrent(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  request: Pick<PreviewAutomationRequest, "operation" | "requestId">,
) {
  const state = readThreadPreviewState(threadRef);
  if (
    state.sessions[tabId] &&
    isCurrentPreviewRuntimeTab(threadRef, state.serverEpoch, tabId, runtimeTabId)
  ) {
    return state;
  }
  throw new PreviewAutomationTargetUnavailableError({
    requestId: request.requestId,
    operation: request.operation,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    bridgeAvailable: Boolean(previewBridge),
  });
}

export async function withCurrentPreviewRuntime<T>(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  request: Pick<PreviewAutomationRequest, "operation" | "requestId">,
  operation: () => Promise<T>,
): Promise<T> {
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, request);
  const result = await operation();
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, request);
  return result;
}

export async function waitForNavigationReadiness(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> {
  const requestedReadiness = readiness ?? "load";
  const bridge = previewBridge;
  if (!bridge) return;
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, { operation, requestId });
  if (requestedReadiness === "none") return;
  const targetReadiness = requestedReadiness;
  const deadline = Date.now() + timeoutMs;
  const quietMs = resolveNetworkIdleQuietMs();
  while (Date.now() <= deadline) {
    if (targetReadiness === "domContentLoaded") {
      const readyState = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () =>
          bridge.automation.evaluate(runtimeTabId, {
            expression: "document.readyState",
          }),
      );
      if (readyState === "interactive" || readyState === "complete") return;
    } else if (targetReadiness === "networkIdle") {
      const status = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () => bridge.automation.status(runtimeTabId),
      );
      const sample = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () =>
          bridge.automation.evaluate(runtimeTabId, {
            expression: NETWORK_IDLE_SAMPLE_EXPRESSION,
          }),
      );
      const parsed =
        typeof sample === "object" && sample !== null
          ? (sample as {
              readyState?: unknown;
              msSinceLastResource?: unknown;
              nowMs?: unknown;
            })
          : null;
      if (
        parsed &&
        typeof parsed.readyState === "string" &&
        (parsed.msSinceLastResource === null || typeof parsed.msSinceLastResource === "number") &&
        typeof parsed.nowMs === "number" &&
        isNetworkIdleSample(
          {
            readyState: parsed.readyState,
            loadingFlag: Boolean(status.available && status.loading),
            msSinceLastResource:
              typeof parsed.msSinceLastResource === "number" || parsed.msSinceLastResource === null
                ? parsed.msSinceLastResource
                : null,
            nowMs: parsed.nowMs,
          },
          quietMs,
        )
      ) {
        return;
      }
    } else {
      const status = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () => bridge.automation.status(runtimeTabId),
      );
      if (status.available && !status.loading) return;
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
  }
  throw new PreviewAutomationNavigationTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    readiness: targetReadiness,
    timeoutMs,
  });
}
