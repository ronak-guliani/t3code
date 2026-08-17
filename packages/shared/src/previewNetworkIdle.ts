import { PREVIEW_NETWORK_IDLE_DEFAULT_MS, PREVIEW_NETWORK_IDLE_MAX_MS } from "@t3tools/contracts";

export type NetworkIdlePollSample = {
  readyState: string;
  loadingFlag: boolean;
  /** Milliseconds since the most recent resource responseEnd, or null if none. */
  msSinceLastResource: number | null;
  nowMs: number;
};

export function resolveNetworkIdleQuietMs(quietMs?: number): number {
  if (quietMs === undefined || !Number.isFinite(quietMs)) {
    return PREVIEW_NETWORK_IDLE_DEFAULT_MS;
  }
  return Math.min(PREVIEW_NETWORK_IDLE_MAX_MS, Math.max(50, Math.floor(quietMs)));
}

/**
 * networkIdle is satisfied when the document is complete, the host is not
 * loading, and no resource finished within the quiet window (or there are no
 * resources yet and the page is complete).
 */
export function isNetworkIdleSample(
  sample: NetworkIdlePollSample,
  quietMs: number = PREVIEW_NETWORK_IDLE_DEFAULT_MS,
): boolean {
  if (sample.loadingFlag) {
    return false;
  }
  if (sample.readyState !== "complete") {
    return false;
  }
  if (sample.msSinceLastResource === null) {
    return true;
  }
  return sample.msSinceLastResource >= quietMs;
}

/** Script evaluated in-page to sample network quietness via the Performance API. */
export const NETWORK_IDLE_SAMPLE_EXPRESSION = `(() => {
  const now = performance.now();
  const resources = performance.getEntriesByType("resource");
  let latest = null;
  for (const entry of resources) {
    const end = entry.responseEnd;
    if (typeof end === "number" && (latest === null || end > latest)) {
      latest = end;
    }
  }
  return {
    readyState: document.readyState,
    msSinceLastResource: latest === null ? null : now - latest,
    nowMs: now,
  };
})()`;
