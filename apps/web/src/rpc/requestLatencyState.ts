import { useAtomValue } from "@effect/atom-react";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
export const EXPECTED_LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000;
export const MAX_TRACKED_RPC_ACK_REQUESTS = 256;
let slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;

const expectedLongRunningRpcTags = new Set<string>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  WS_METHODS.gitPreparePullRequestThread,
  WS_METHODS.gitRunStackedAction,
  WS_METHODS.serverRefreshProviders,
]);

export interface SlowRpcAckRequest {
  readonly requestId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly tag: string;
  readonly thresholdMs: number;
}

interface PendingRpcAckRequest {
  readonly request: SlowRpcAckRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>();

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests]);
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest> {
  return appAtomRegistry.get(slowRpcAckRequestsAtom);
}

function getRpcAckThresholdMs(tag: string): number | null {
  if (tag.includes("subscribe")) {
    return null;
  }

  if (slowRpcAckThresholdMs !== SLOW_RPC_ACK_THRESHOLD_MS) {
    return slowRpcAckThresholdMs;
  }

  return expectedLongRunningRpcTags.has(tag)
    ? EXPECTED_LONG_RUNNING_RPC_ACK_THRESHOLD_MS
    : SLOW_RPC_ACK_THRESHOLD_MS;
}

export function getSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return getSlowRpcAckRequestsValue();
}

export function trackRpcRequestSent(requestId: string, tag: string): void {
  const thresholdMs = getRpcAckThresholdMs(tag);
  if (thresholdMs === null) {
    return;
  }

  clearTrackedRpcRequest(requestId);
  evictOldestPendingRpcRequestIfNeeded();

  const startedAtMs = Date.now();
  const request: SlowRpcAckRequest = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs,
  };
  const timeoutId = setTimeout(() => {
    pendingRpcAckRequests.delete(requestId);
    appendSlowRpcAckRequest(request);
  }, thresholdMs);

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearTrackedRpcRequest(requestId);
  const slowRequests = getSlowRpcAckRequestsValue();
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

export function clearAllTrackedRpcRequests(): void {
  for (const pending of pendingRpcAckRequests.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingRpcAckRequests.clear();
  setSlowRpcAckRequests([]);
}

function clearTrackedRpcRequest(requestId: string): void {
  const pending = pendingRpcAckRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRpcAckRequests.delete(requestId);
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void {
  const requests = [...getSlowRpcAckRequestsValue(), request];
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS) {
    setSlowRpcAckRequests(requests);
    return;
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
}

function evictOldestPendingRpcRequestIfNeeded(): void {
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value;
    if (oldestRequestId === undefined) {
      return;
    }

    clearTrackedRpcRequest(oldestRequestId);
  }
}

export function resetRequestLatencyStateForTests(): void {
  slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;
  clearAllTrackedRpcRequests();
}

export function setSlowRpcAckThresholdMsForTests(thresholdMs: number): void {
  slowRpcAckThresholdMs = thresholdMs;
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return useAtomValue(slowRpcAckRequestsAtom);
}
