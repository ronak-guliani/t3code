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
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { useParams, useRouter } from "@tanstack/react-router";
import {
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

type ShelfThread = SidebarThreadSummary & {
  readonly projectName: string;
};

function sortByRecent(left: ShelfThread, right: ShelfThread): number {
  const leftAt = left.updatedAt ?? left.createdAt;
  const rightAt = right.updatedAt ?? right.createdAt;
  return rightAt.localeCompare(leftAt) || left.title.localeCompare(right.title);
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

function ThreadRow({
  thread,
  active,
  onOpen,
  onSettle,
  onUnsettle,
  onSnooze,
  onUnsnooze,
}: {
  readonly thread: ShelfThread;
  readonly active: boolean;
  readonly onOpen: (thread: ShelfThread) => void;
  readonly onSettle: (thread: ShelfThread) => void;
  readonly onUnsettle: (thread: ShelfThread) => void;
  readonly onSnooze: (thread: ShelfThread, until: string) => void;
  readonly onUnsnooze: (thread: ShelfThread) => void;
}) {
  const status = resolveThreadStatusPill({ thread });
  const snoozed = effectiveSnoozed(thread, { now: nowIso() });
  const raisedHand = threadRaisedHandWhileSnoozed(thread);

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
            <span className="truncate">{thread.projectName}</span>
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
              onClick={(event) => {
                event.stopPropagation();
                onSnooze(thread, fourHoursFromNow());
              }}
              size="icon-xs"
              title="Snooze for 4 hours"
              variant="ghost"
            >
              <Clock3Icon />
            </Button>
            <Button
              aria-label={
                thread.settledOverride === "settled"
                  ? `Reopen ${thread.title}`
                  : `Settle ${thread.title}`
              }
              onClick={(event) => {
                event.stopPropagation();
                if (thread.settledOverride === "settled") {
                  onUnsettle(thread);
                } else {
                  onSettle(thread);
                }
              }}
              size="icon-xs"
              title={thread.settledOverride === "settled" ? "Reopen thread" : "Settle thread"}
              variant="ghost"
            >
              {thread.settledOverride === "settled" ? <RotateCcwIcon /> : <CheckCircle2Icon />}
            </Button>
          </>
        )}
      </div>
    </SidebarMenuItem>
  );
}

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
  const { projects, threads } = useStore(
    useShallow((state) => ({
      projects: selectProjectsAcrossEnvironments(state),
      threads: selectSidebarThreadsAcrossEnvironments(state),
    })),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowIso()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const shelves = useMemo(() => {
    const projectsByKey = projectNameByScopedKey(projects);
    const visible = threads
      .filter((thread) => thread.archivedAt === null)
      .map(
        (thread): ShelfThread => ({
          ...thread,
          projectName:
            projectsByKey.get(
              scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
            ) ?? "Unknown project",
        }),
      );
    const active: ShelfThread[] = [];
    const snoozed: ShelfThread[] = [];
    const settled: ShelfThread[] = [];
    for (const thread of visible) {
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
  }, [now, projects, threads]);

  const openedSettled = useMemo(() => {
    const activeKey = activeThreadRef
      ? `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`
      : null;
    const included = shelves.settled.slice(0, settledVisibleCount);
    if (
      activeKey !== null &&
      !included.some((thread) => `${thread.environmentId}:${thread.id}` === activeKey)
    ) {
      const routed = shelves.settled.find(
        (thread) => `${thread.environmentId}:${thread.id}` === activeKey,
      );
      if (routed) return [...included, routed];
    }
    return included;
  }, [activeThreadRef, settledVisibleCount, shelves.settled]);

  const openThread = useCallback(
    (thread: ShelfThread) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [router],
  );
  const runAction = useCallback((action: () => Promise<void>) => {
    void action().catch((error: unknown) => {
      console.error("Sidebar inbox lifecycle action failed", error);
    });
  }, []);
  const isActive = useCallback(
    (thread: ShelfThread) =>
      activeThreadRef?.environmentId === thread.environmentId &&
      activeThreadRef.threadId === thread.id,
    [activeThreadRef],
  );
  const renderThread = useCallback(
    (thread: ShelfThread) => (
      <ThreadRow
        key={`${thread.environmentId}:${thread.id}`}
        active={isActive(thread)}
        onOpen={openThread}
        onSettle={(selected) =>
          runAction(() => settleThread(scopeThreadRef(selected.environmentId, selected.id)))
        }
        onSnooze={(selected, until) =>
          runAction(() => snoozeThread(scopeThreadRef(selected.environmentId, selected.id), until))
        }
        onUnsettle={(selected) =>
          runAction(() => unsettleThread(scopeThreadRef(selected.environmentId, selected.id)))
        }
        onUnsnooze={(selected) =>
          runAction(() => unsnoozeThread(scopeThreadRef(selected.environmentId, selected.id)))
        }
        thread={thread}
      />
    ),
    [isActive, openThread, runAction, settleThread, snoozeThread, unsettleThread, unsnoozeThread],
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
                    runAction(() =>
                      unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
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
                    runAction(() =>
                      snoozeThread(
                        scopeThreadRef(thread.environmentId, thread.id),
                        startOfTomorrow(),
                      ),
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
