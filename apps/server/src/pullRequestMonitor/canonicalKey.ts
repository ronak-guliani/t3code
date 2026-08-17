import type { PullRequestMonitorCanonicalKey } from "@t3tools/contracts";

/** Runtime formatter kept out of schema-only `packages/contracts`. */
export function formatPullRequestMonitorCanonicalKey(key: PullRequestMonitorCanonicalKey): string {
  return `${key.provider}:${key.host}:${key.repository}#${key.number}`;
}
