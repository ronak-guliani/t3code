import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { ChatSplitArea } from "../components/ChatSplitArea";
import { AgentRunChatView } from "../components/chat/AgentRunChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { deriveAgentRuns } from "../session-logic";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import {
  resolveThreadRouteRef,
  parseAgentRunRouteSearch,
  parseThreadMessageRouteSearch,
  type AgentRunRouteSearch,
  type ThreadMessageRouteSearch,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { RootRouteErrorView } from "./__root";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();
  // Stable route target — threadRef may be a new object on every render (useParams
  // can return fresh refs), but the string values only change on actual navigation.
  // An inline `{ kind, threadRef }` literal would be a new object every render,
  // causing downstream effects in ChatSplitArea to fire unnecessarily.
  const routeTarget = useMemo<ThreadRouteTarget | null>(
    () => (threadRef ? { kind: "server", threadRef } : null),
    // oxlint wants `threadRef` as the dep, but that defeats the purpose — threadRef
    // is a new object on every render from useParams. We depend on the primitives.
    [threadRef?.environmentId, threadRef?.threadId],
  );
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, environmentId).bootstrapComplete,
  );
  // threadRef is a fresh object on every useParams evaluation; depend on the
  // primitives so the selector (and its subscription) stays stable.
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(threadRef), [environmentId, threadId]),
  );
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const agentRun = useMemo(
    () =>
      search.agent
        ? deriveAgentRuns(serverThread?.activities ?? [], undefined).find(
            (run) => run.taskId === search.agent,
          )
        : undefined,
    [search.agent, serverThread?.activities],
  );
  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !routeTarget || (bootstrapComplete && !routeThreadExists)) {
    return null;
  }

  if (!bootstrapComplete) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-chat-background text-foreground md:h-dvh">
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 p-4"
          role="status"
          aria-live="polite"
          aria-label="Loading thread"
        >
          <Skeleton className="h-8 w-2/5 rounded-md" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-11/12 rounded-lg" />
          <Skeleton className="h-16 w-3/5 rounded-lg" />
          <span className="sr-only">Loading thread</span>
        </div>
      </SidebarInset>
    );
  }

  if (agentRun && serverThread) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-chat-background text-foreground md:h-dvh">
        <AgentRunChatView
          agentRun={agentRun}
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          workspaceRoot={serverThread.worktreePath ?? undefined}
        />
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-chat-background text-foreground md:h-dvh">
      <ChatSplitArea routeTarget={routeTarget} routeDiffSearch={search} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search): DiffRouteSearch & AgentRunRouteSearch & ThreadMessageRouteSearch => ({
    ...parseDiffRouteSearch(search),
    ...parseAgentRunRouteSearch(search),
    ...parseThreadMessageRouteSearch(search),
  }),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch & AgentRunRouteSearch & ThreadMessageRouteSearch>([
        "message",
      ]),
    ],
  },
  component: ChatThreadRouteView,
  errorComponent: RootRouteErrorView,
});
