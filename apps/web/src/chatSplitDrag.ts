import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

export const CHAT_SPLIT_THREAD_DRAG_MIME = "application/x-t3code-thread-ref";

interface ChatSplitThreadDragPayload {
  kind: "thread";
  environmentId: string;
  threadId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function encodeChatSplitThreadDragPayload(threadRef: ScopedThreadRef): string {
  return JSON.stringify({
    kind: "thread",
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  } satisfies ChatSplitThreadDragPayload);
}

export function decodeChatSplitThreadDragPayload(raw: string): ScopedThreadRef | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.kind !== "thread" ||
      typeof parsed.environmentId !== "string" ||
      parsed.environmentId.length === 0 ||
      typeof parsed.threadId !== "string" ||
      parsed.threadId.length === 0
    ) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(parsed.environmentId),
      threadId: ThreadId.make(parsed.threadId),
    };
  } catch {
    return null;
  }
}
