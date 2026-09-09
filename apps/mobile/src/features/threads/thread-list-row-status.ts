import { hierarchyThreadKey } from "@t3tools/client-runtime/state/thread-hierarchy";

import {
  resolveNestedThreadStatus,
  type MobileThreadShell,
  type NestedThreadStatus,
} from "./mobile-thread-hierarchy";
import { resolveThreadStatus } from "./threadPresentation";

export type ThreadListRowStatus =
  | NestedThreadStatus
  | "queued"
  | "draft"
  | "plan-ready"
  | "completed";

export function resolveThreadListRowStatus(
  thread: MobileThreadShell,
  completionReadAt?: Readonly<Record<string, string>>,
): Exclude<ThreadListRowStatus, "queued" | "draft"> {
  const ownStatus = resolveNestedThreadStatus(thread);
  const semanticStatus = resolveThreadStatus(
    thread,
    completionReadAt?.[hierarchyThreadKey(thread)],
  );
  if (ownStatus === "ready" && semanticStatus?.kind === "plan-ready") return "plan-ready";
  if (semanticStatus?.kind === "completed") return "completed";
  return ownStatus;
}
