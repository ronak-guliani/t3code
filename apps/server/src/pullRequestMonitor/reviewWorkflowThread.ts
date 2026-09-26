import type { OrchestrationThread } from "@t3tools/contracts";

export function isReviewWorkflowThread(
  thread: Pick<OrchestrationThread, "id" | "reviewSnapshot" | "reviewResult">,
): boolean {
  return (
    thread.reviewSnapshot != null &&
    (thread.reviewResult == null || thread.id.endsWith(":node:review-changes:worker"))
  );
}
