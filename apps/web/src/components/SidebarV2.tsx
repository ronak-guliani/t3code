import {
  ArchiveIcon,
  BellOffIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  InboxIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  QUEUED_TURN_START_GRACE_MS,
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";

import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import type { Project, SidebarThreadSummary } from "../types";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

const SETTLED_PAGE_SIZE = 25;

function sortByRecent(left: SidebarThreadSummary, right: SidebarThreadSummary): number {
  const leftAt = left.updatedAt ?? left.createdAt;
  const rightAt = right.updatedAt ?? right.createdAt;
  // ISO-8601 UTC timestamps sort lexicographically, so a plain comparison is
  // both correct and far cheaper than locale-aware collation.
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? 1 : -1;
  }
  return left.title.localeCompare(right.title);
}

function projectNameByScopedKey(projects: readonly Project[]): Map<string, string> {
  return new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.name,
    ]),
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function startOfTomorrow(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function fourHoursFromNow(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString();
}

const ThreadRow = memo(function ThreadRow({
  thread,
  projectName,
  active,
  now,
  onOpen,
  onSettle,
  onUnsettle,
  onSnooze,
  onUnsnooze,
}: {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly active: boolean;
  readonly now: string;
  readonly onOpen: (thread: SidebarThreadSummary) => void;
  readonly onSettle: (thread: SidebarThreadSummary) => void;
  readonly onUnsettle: (thread: SidebarThreadSummary) => void;
  readonly onSnooze: (thread: SidebarThreadSummary, until: string) => void;
  readonly onUnsnooze: (thread: SidebarThreadSummary) => void;
}) {
  const status = resolveThreadStatusPill({ thread });
  const snoozed = effectiveSnoozed(thread, { now });
  const raisedHand = threadRaisedHandWhileSnoozed(thread);
  const settled = thread.settledOverride === "settled";
  // Reopening is always allowed; only the settle direction has preconditions.
  const settleBlocked = !settled && !canSettle(thread, { now });
  const snoozeBlocked = !canSnooze(thread, { now });

  return (
    <SidebarMenuItem className="group/thread">
      <SidebarMenuButton
        isActive={active}
        onClick={() => onOpen(thread)}
        className="h-auto min-h-11 items-start px-2 py-1.5"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {status ? (
              <ThreadStatusLabel compact status={status} />
            ) : (
              <InboxIcon className="size-3.5" />
            )}
            <span className="truncate font-medium">{thread.title}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{projectName}</span>
            <span aria-hidden="true">-</span>
            <span className="shrink-0">
              {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
            </span>
            {snoozed ? (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {formatRelativeTimeUntilLabel(thread.snoozedUntil!)}
              </span>
            ) : null}
            {raisedHand ? (
              <span className="ml-auto shrink-0 text-amber-600">Needs attention</span>
            ) : null}
          </span>
        </span>
      </SidebarMenuButton>
      <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-hover/thread:flex group-focus-within/thread:flex">
        {snoozed ? (
          <Button
            aria-label={`Wake ${thread.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onUnsnooze(thread);
            }}
            size="icon-xs"
            title="Wake now"
            variant="ghost"
          >
            <RotateCcwIcon />
          </Button>
        ) : (
          <>
            <Button
              aria-label={`Snooze ${thread.title} for four hours`}
              disabled={snoozeBlocked}
              onClick={(event) => {
                event.stopPropagation();
                onSnooze(thread, fourHoursFromNow());
              }}
              size="icon-xs"
              title={
                snoozeBlocked ? "Cannot snooze work that is waiting on you" : "Snooze for 4 hours"
              }
              variant="ghost"
            >
              <Clock3Icon />
            </Button>
            <Button
              aria-label={settled ? `Reopen ${thread.title}` : `Settle ${thread.title}`}
              disabled={settleBlocked}
              onClick={(event) => {
                event.stopPropagation();
                if (settled) {
                  onUnsettle(thread);
                } else {
                  onSettle(thread);
                }
              }}
              size="icon-xs"
              title={
                settled
                  ? "Reopen thread"
                  : settleBlocked
                    ? "Cannot settle a thread with active or pending work"
                    : "Settle thread"
              }
              variant="ghost"
            >
              {settled ? <RotateCcwIcon /> : <CheckCircle2Icon />}
            </Button>
          </>
        )}
      </div>
    </SidebarMenuItem>
  );
});

function Shelf({
  title,
  icon,
  count,
  children,
  defaultOpen = true,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly count: number;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <SidebarGroup className="px-2 py-0">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
        {icon}
        <span>{title}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </button>
      <div id={contentId}>{open ? children : null}</div>
    </SidebarGroup>
  );
}

export default function SidebarV2() {
  const [now, setNow] = useState(nowIso);
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_PAGE_SIZE);
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const { settleThread, snoozeThread, unsettleThread, unsnoozeThread } = useThreadActions();
  const router = useRouter();
  const params = useParams({ strict: false });
  const activeThreadRef = resolveThreadRouteRef(params);
  const activeThreadKey = activeThreadRef
    ? `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`
    : null;
  const { projects, threads } = useStore(
    useShallow((state) => ({
      projects: selectProjectsAcrossEnvironments(state),
      threads: selectSidebarThreadsAcrossEnvironments(state),
    })),
  );

  // Classification only changes on its own at two known instants: a snooze
  // elapsing, or a queued turn start ageing out of its grace window. Waking
  // exactly then beats polling every minute and keeps snoozes punctual.
  useEffect(() => {
    const nowMs = Date.parse(now);
    let nextAt = Number.POSITIVE_INFINITY;
    for (const thread of threads) {
      const snoozedUntil = thread.snoozedUntil ?? null;
      const wakeAt = snoozedUntil === null ? Number.NaN : Date.parse(snoozedUntil);
      if (wakeAt > nowMs) {
        nextAt = Math.min(nextAt, wakeAt);
      }
      const messageAt =
        thread.latestUserMessageAt === null ? Number.NaN : Date.parse(thread.latestUserMessageAt);
      const graceEndsAt = messageAt + QUEUED_TURN_START_GRACE_MS;
      if (graceEndsAt > nowMs) {
        nextAt = Math.min(nextAt, graceEndsAt);
      }
    }
    if (!Number.isFinite(nextAt)) {
      return undefined;
    }
    // setTimeout delays are signed 32-bit: anything larger overflows and fires
    // immediately. The padding keeps the wake strictly past the boundary.
    const delayMs = Math.min(Math.max(0, nextAt - Date.now()) + 50, 2_147_483_647);
    const timer = window.setTimeout(() => setNow(nowIso()), delayMs);
    return () => window.clearTimeout(timer);
  }, [now, threads]);

  const projectNames = useMemo(() => projectNameByScopedKey(projects), [projects]);

  // Classifies the store's own thread objects rather than rebuilt copies, so
  // rows that did not change keep their identity and stay memoized.
  const shelves = useMemo(() => {
    const active: SidebarThreadSummary[] = [];
    const snoozed: SidebarThreadSummary[] = [];
    const settled: SidebarThreadSummary[] = [];
    for (const thread of threads) {
      if (thread.archivedAt !== null) {
        continue;
      }
      if (effectiveSnoozed(thread, { now })) {
        snoozed.push(thread);
      } else if (effectiveSettled(thread, { now })) {
        settled.push(thread);
      } else {
        active.push(thread);
      }
    }
    return {
      active: active.toSorted(sortByRecent),
      snoozed: snoozed.toSorted(sortByRecent),
      settled: settled.toSorted(sortByRecent),
    };
  }, [now, threads]);

  const openedSettled = useMemo(() => {
    const included = shelves.settled.slice(0, settledVisibleCount);
    if (
      activeThreadKey !== null &&
      !included.some((thread) => `${thread.environmentId}:${thread.id}` === activeThreadKey)
    ) {
      const routed = shelves.settled.find(
        (thread) => `${thread.environmentId}:${thread.id}` === activeThreadKey,
      );
      if (routed) return [...included, routed];
    }
    return included;
  }, [activeThreadKey, settledVisibleCount, shelves.settled]);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [router],
  );
  const runAction = useCallback((action: () => Promise<void>, actionLabel: string) => {
    void action().catch((error: unknown) => {
      const description =
        error instanceof Error ? error.message : "An unexpected error prevented this action.";
      console.error("Sidebar inbox lifecycle action failed", error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to ${actionLabel}`,
          description,
        }),
      );
    });
  }, []);
  // Stable per-action handlers: inline arrows would give every row fresh props
  // on each render and defeat ThreadRow's memoization.
  const handleSettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => settleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "settle thread",
      );
    },
    [runAction, settleThread],
  );
  const handleUnsettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsettleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "reopen thread",
      );
    },
    [runAction, unsettleThread],
  );
  const handleSnooze = useCallback(
    (thread: SidebarThreadSummary, until: string) => {
      runAction(
        () => snoozeThread(scopeThreadRef(thread.environmentId, thread.id), until),
        "snooze thread",
      );
    },
    [runAction, snoozeThread],
  );
  const handleUnsnooze = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
        "wake thread",
      );
    },
    [runAction, unsnoozeThread],
  );
  const renderThread = useCallback(
    (thread: SidebarThreadSummary) => (
      <ThreadRow
        key={`${thread.environmentId}:${thread.id}`}
        active={`${thread.environmentId}:${thread.id}` === activeThreadKey}
        now={now}
        onOpen={openThread}
        onSettle={handleSettle}
        onSnooze={handleSnooze}
        onUnsettle={handleUnsettle}
        onUnsnooze={handleUnsnooze}
        projectName={
          projectNames.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          ) ?? "Unknown project"
        }
        thread={thread}
      />
    ),
    [
      activeThreadKey,
      handleSettle,
      handleSnooze,
      handleUnsettle,
      handleUnsnooze,
      now,
      openThread,
      projectNames,
    ],
  );

  return (
    <>
      <SidebarHeader>
        <div className="flex items-center justify-between px-2">
          <span className="text-sm font-semibold">Inbox</span>
          <Button
            disabled={defaultProjectRef === null}
            onClick={() => {
              if (defaultProjectRef) void handleNewThread(defaultProjectRef);
            }}
            size="icon-sm"
            title="New thread"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-1">
        <Shelf
          count={shelves.active.length}
          icon={<InboxIcon className="size-3.5" />}
          title="Active"
        >
          <SidebarMenu>{shelves.active.map(renderThread)}</SidebarMenu>
        </Shelf>
        <Shelf
          count={shelves.snoozed.length}
          defaultOpen={false}
          icon={<BellOffIcon className="size-3.5" />}
          title="Snoozed"
        >
          <SidebarMenu>{shelves.snoozed.map(renderThread)}</SidebarMenu>
          {shelves.snoozed.length > 0 ? (
            <div className="flex gap-1 px-2 py-1">
              <Button
                onClick={() =>
                  shelves.snoozed.forEach((thread) =>
                    runAction(
                      () => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
                      "wake thread",
                    ),
                  )
                }
                size="xs"
                variant="ghost"
              >
                Wake all
              </Button>
              <Button
                onClick={() =>
                  shelves.snoozed.forEach((thread) =>
                    runAction(
                      () =>
                        snoozeThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                          startOfTomorrow(),
                        ),
                      "snooze thread",
                    ),
                  )
                }
                size="xs"
                variant="ghost"
              >
                Until tomorrow
              </Button>
            </div>
          ) : null}
        </Shelf>
        <Shelf
          count={shelves.settled.length}
          defaultOpen={false}
          icon={<ArchiveIcon className="size-3.5" />}
          title="Settled"
        >
          <SidebarMenu>{openedSettled.map(renderThread)}</SidebarMenu>
          {shelves.settled.length > openedSettled.length ? (
            <Button
              className="mx-2 mt-1"
              onClick={() => setSettledVisibleCount((count) => count + SETTLED_PAGE_SIZE)}
              size="sm"
              variant="ghost"
            >
              Show more
            </Button>
          ) : null}
        </Shelf>
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroupLabel className="px-2 text-[11px]">
          Manual settling only - active work always stays visible.
        </SidebarGroupLabel>
      </SidebarFooter>
    </>
  );
}
