import {
  CommandId,
  MessageId,
  QueuedTurnId,
  type ChildNudgeUpdate,
  type ChildWaitCondition,
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type OrchestrationQueuedTurn,
} from "@t3tools/contracts";
import {
  childWaitBlockReason,
  childWaitIsSatisfied,
  evaluateChildFollowUp,
} from "@t3tools/shared/childFollowUp";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  GitForkIcon,
  PauseIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { readEnvironmentApi } from "../../environmentApi";
import { useStore } from "../../store";
import type { Thread, ThreadShell } from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

export const ChildReportDetails = memo(function ChildReportDetails({
  report,
  environmentId,
}: {
  report: ChildNudgeUpdate;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  return (
    <div className="min-w-0 py-1">
      <button
        type="button"
        className="chat-work-trigger font-medium"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: report.childThreadId },
            search: (previous) => ({
              ...previous,
              message: report.sourceMessageId ?? report.assignmentId,
            }),
          })
        }
      >
        <GitForkIcon aria-hidden="true" />
        {report.childTitle}
        <span className="font-normal text-muted-foreground">
          {report.kind === "result-available"
            ? "Result available"
            : report.kind === "decision-needed"
              ? "Decision needed"
              : report.kind === "failed"
                ? "Failed"
                : report.kind === "blocked"
                  ? "Completion unconfirmed"
                  : "Update"}
        </span>
      </button>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{report.summary}</p>
      {report.decision ? (
        <div className="mt-1 space-y-1">
          <p className="whitespace-pre-wrap break-words">{report.decision.question}</p>
          {report.decision.options?.map((option, index) => (
            <p key={option} className="break-words text-muted-foreground">
              {index + 1}. {option}
            </p>
          ))}
          {report.decision.recommendation ? (
            <p className="break-words">Recommended: {report.decision.recommendation}</p>
          ) : null}
        </div>
      ) : null}
      {report.canContinue !== undefined ? (
        <p className="mt-1 text-muted-foreground">
          {report.canContinue
            ? "Child can continue without an answer."
            : "Child is waiting for an answer."}
        </p>
      ) : null}
    </div>
  );
});

export const ChildFollowUpReceipt = memo(function ChildFollowUpReceipt({
  updates,
  environmentId,
  forceExpanded = false,
  initialExpanded = false,
  onExpandedChange,
}: {
  updates: ReadonlyArray<ChildNudgeUpdate>;
  environmentId: EnvironmentId;
  forceExpanded?: boolean;
  initialExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  return (
    <Collapsible
      className="work-group-section"
      open={forceExpanded || expanded}
      onOpenChange={(value) => {
        setExpanded(value);
        onExpandedChange?.(value);
      }}
    >
      <CollapsibleTrigger className="chat-work-trigger text-muted-foreground">
        <GitForkIcon aria-hidden="true" />
        <span className="chat-work-label">
          Continued with {updates.length} child {updates.length === 1 ? "update" : "updates"}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "transition-transform motion-reduce:transition-none",
            (expanded || forceExpanded) && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-[0.5em] border-l border-border/50 py-1 pl-[1em]">
          {updates.map((report) => (
            <ChildReportDetails key={report.id} report={report} environmentId={environmentId} />
          ))}
          <p className="text-muted-foreground">
            Delivered to the parent. Results and decisions still require review.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

function ChildDecisionReply({
  child,
  report,
  dispatch,
}: {
  child: ThreadShell;
  report: ChildNudgeUpdate;
  dispatch: (command: ClientOrchestrationCommand) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef<{ text: string; command: ClientOrchestrationCommand } | null>(null);
  if (!open)
    return (
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Respond to {child.title}
      </Button>
    );
  const send = async () => {
    if (sending || !text.trim()) return;
    if (!pending.current || pending.current.text !== text) {
      pending.current = {
        text,
        command: {
          type: "thread.queued-turn.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: child.id,
          queuedTurnId: QueuedTurnId.make(crypto.randomUUID()),
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text,
            attachments: [],
          },
          assignmentId: report.assignmentId,
          respondToReportId: report.id,
          runtimeMode: child.runtimeMode,
          interactionMode: child.interactionMode,
          createdAt: new Date().toISOString(),
        },
      };
    }
    setSending(true);
    const sent = await dispatch(pending.current.command);
    setSending(false);
    if (sent) {
      pending.current = null;
      setOpen(false);
      setText("");
    }
  };
  return (
    <div className="space-y-1 py-1">
      <textarea
        aria-label={`Response to ${child.title}`}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        className="min-h-20 w-full resize-y rounded-md border border-border bg-background p-2 text-foreground focus-visible:outline-ring"
      />
      <div className="flex gap-1">
        <Button size="xs" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? "Sending..." : "Send response"}
        </Button>
        <Button size="xs" variant="ghost" disabled={sending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export const ChildFollowUpPanel = memo(function ChildFollowUpPanel({
  thread,
  queuedTurns,
  isWorking,
  blockedByInteraction = false,
  onError,
}: {
  thread: Thread;
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>;
  isWorking: boolean;
  blockedByInteraction?: boolean;
  onError: (threadId: Thread["id"] | null, error: string | null) => void;
}) {
  const nudges = useMemo(
    () => queuedTurns.filter((turn) => turn.origin?.kind === "child-nudge"),
    [queuedTurns],
  );
  const reportedChildIds = useMemo(
    () =>
      new Set(
        nudges.flatMap((turn) =>
          turn.origin?.kind === "child-nudge"
            ? turn.origin.updates.map((report) => report.childThreadId)
            : [],
        ),
      ),
    [nudges],
  );
  const referencedChildren = useStore(
    useShallow((state) => {
      const environment = state.environmentStateById[thread.environmentId];
      return (environment?.threadIdsByProjectId[thread.projectId] ?? []).flatMap((id) => {
        const child = environment?.threadShellById[id];
        return child &&
          (reportedChildIds.has(id) ||
            (child.parentThreadId === thread.id &&
              child.archivedAt === null &&
              child.nudging?.delegation))
          ? [child]
          : [];
      });
    }),
  );
  const childById = useMemo(
    () => new Map(referencedChildren.map((child) => [child.id, child])),
    [referencedChildren],
  );
  const children = referencedChildren.filter(
    (child) =>
      child.parentThreadId === thread.id && child.archivedAt === null && child.nudging?.delegation,
  );
  const [expanded, setExpanded] = useState(false);
  const [choosingWait, setChoosingWait] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [waitMode, setWaitMode] = useState<"any" | "all">("all");
  const [changing, setChanging] = useState(false);
  const [now, setNow] = useState(Date.now);
  const currentTime = new Date(Math.max(now, Date.now())).toISOString();
  const currentNudges = nudges.flatMap((turn) => {
    const followUp = evaluateChildFollowUp(thread, turn, childById, currentTime);
    return followUp.updates.length ? [{ turn, followUp }] : [];
  });
  const navigate = useNavigate();
  useEffect(() => {
    const deadlines = nudges
      .flatMap((turn) =>
        turn.origin?.kind === "child-nudge" && turn.origin.collectUntil
          ? [Date.parse(turn.origin.collectUntil)]
          : [],
      )
      .filter((deadline) => deadline > Date.now());
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nudges, now]);
  const dispatch = useCallback(
    async (command: ClientOrchestrationCommand) => {
      const api = readEnvironmentApi(thread.environmentId);
      if (!api) {
        onError(thread.id, "Cannot change child follow-up while disconnected.");
        return false;
      }
      try {
        await api.orchestration.dispatchCommand(command);
        onError(thread.id, null);
        return true;
      } catch (error) {
        onError(
          thread.id,
          error instanceof Error ? error.message : "Failed to change child follow-up.",
        );
        return false;
      }
    },
    [thread.id, thread.environmentId, onError],
  );
  const changeWait = async (wait: ChildWaitCondition | null) => {
    setChanging(true);
    const changed = await dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(crypto.randomUUID()),
      threadId: thread.id,
      childWait: wait,
    });
    setChanging(false);
    if (changed) setChoosingWait(false);
  };
  const active = children.filter((child) => child.nudging?.delegation?.completedAt === null);
  const decisionChild = children.find((child) => child.nudging?.delegation?.decision);
  const paused = thread.nudging?.paused === true;
  const wait = thread.nudging?.wait;
  const waiting = !!wait && !wait.satisfiedAt && !childWaitIsSatisfied(wait);
  const relevantIds = new Set([
    ...(waiting ? wait.assignments.map((entry) => entry.childThreadId) : []),
    ...currentNudges.flatMap(({ followUp }) =>
      followUp.updates.map((report) => report.childThreadId),
    ),
  ]);
  const visibleChildren = children.filter(
    (child) =>
      child.nudging?.delegation?.completedAt === null ||
      child.nudging?.delegation?.decision ||
      relevantIds.has(child.id),
  );
  const failedChild = visibleChildren.find((child) => {
    const outcome = child.nudging?.delegation?.outcome;
    return outcome === "failed" || outcome === "blocked";
  });
  const waitReason = childWaitBlockReason(wait, childById, thread.id);
  const pendingCount = currentNudges.reduce(
    (count, { followUp }) => count + followUp.updates.length,
    0,
  );
  const failedDelivery = currentNudges.some(({ turn }) => turn.failedAt !== null);
  const collecting = currentNudges.some(({ followUp }) => followUp.dueAt !== null);
  if (!active.length && !pendingCount && !decisionChild && !paused && !waiting) return null;
  const label = decisionChild
    ? `Decision needed · ${decisionChild.title}`
    : failedDelivery
      ? "Child follow-up delivery failed"
      : failedChild && (waiting || pendingCount > 0)
        ? `Child needs attention · ${failedChild.title}`
        : paused
          ? `Child follow-up paused · ${pendingCount} updates pending`
          : (waitReason ??
            (pendingCount
              ? blockedByInteraction
                ? `${pendingCount} child updates ready · Awaiting your input`
                : isWorking
                  ? `${pendingCount} child updates ready · After current response`
                  : collecting
                    ? "Collecting child results"
                    : `${pendingCount} child updates ready`
              : `${active.length} ${active.length === 1 ? "child" : "children"} working`));
  return (
    <div className="work-group-section border-b border-border/55 px-3 py-2" aria-label="Child work">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-center gap-1">
          <CollapsibleTrigger className="chat-work-trigger min-w-0 flex-1 text-muted-foreground">
            {decisionChild || failedChild ? (
              <CircleAlertIcon className="text-amber-700 dark:text-amber-400" aria-hidden="true" />
            ) : paused ? (
              <PauseIcon aria-hidden="true" />
            ) : (
              <GitForkIcon aria-hidden="true" />
            )}
            <span className="chat-work-label">{label}</span>
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "transition-transform motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Child follow-up controls" />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() =>
                  void dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.make(crypto.randomUUID()),
                    threadId: thread.id,
                    childFollowUpPaused: !paused,
                  })
                }
              >
                {paused ? "Resume child follow-up" : "Pause child follow-up"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  setSelected(new Set(active.map((child) => child.id)));
                  setChoosingWait(true);
                  setExpanded(true);
                }}
              >
                Wait for selected children...
              </MenuItem>
              <MenuItem
                onClick={() => void changeWait({ mode: "decisions-only", assignments: [] })}
              >
                Decisions and blockers only
              </MenuItem>
              <MenuItem onClick={() => void changeWait(null)}>Automatic follow-up</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <CollapsibleContent keepMounted>
          <div className="ml-[0.5em] space-y-1 border-l border-border/50 py-1 pl-[1em]">
            {paused ? (
              <p className="text-muted-foreground">
                Automatic follow-up is paused. New updates remain available here.
              </p>
            ) : null}
            {choosingWait ? (
              <fieldset disabled={changing} className="space-y-1 py-1">
                <legend>Continue when selected children return</legend>
                <div className="flex gap-3">
                  <label>
                    <input
                      type="radio"
                      name="child-wait-mode"
                      checked={waitMode === "all"}
                      onChange={() => setWaitMode("all")}
                    />{" "}
                    All selected
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="child-wait-mode"
                      checked={waitMode === "any"}
                      onChange={() => setWaitMode("any")}
                    />{" "}
                    Any selected
                  </label>
                </div>
                {children.map((child) => (
                  <label key={child.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(child.id)}
                      onChange={(event) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(child.id);
                          else next.delete(child.id);
                          return next;
                        })
                      }
                    />
                    {child.title}
                  </label>
                ))}
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    disabled={!selected.size || selected.size > 32}
                    onClick={() =>
                      void changeWait({
                        mode: waitMode,
                        assignments: children.flatMap((child) =>
                          selected.has(child.id) && child.nudging?.delegation
                            ? [
                                {
                                  childThreadId: child.id,
                                  assignmentId: child.nudging.delegation.assignmentId,
                                },
                              ]
                            : [],
                        ),
                      })
                    }
                  >
                    Save wait condition
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setChoosingWait(false)}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            ) : null}
            {visibleChildren.map((child) => {
              const delegation = child.nudging?.delegation;
              if (!delegation) return null;
              return (
                <div key={child.id}>
                  {delegation.decision ? (
                    <>
                      <ChildReportDetails
                        report={delegation.decision}
                        environmentId={thread.environmentId}
                      />
                      <ChildDecisionReply
                        key={delegation.decision.id}
                        child={child}
                        report={delegation.decision}
                        dispatch={dispatch}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="chat-work-trigger text-muted-foreground"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: { environmentId: thread.environmentId, threadId: child.id },
                        })
                      }
                    >
                      {delegation.outcome === "result-available" ? (
                        <CheckIcon aria-hidden="true" />
                      ) : (
                        <GitForkIcon aria-hidden="true" />
                      )}
                      <span className="chat-work-label">{child.title}</span>
                      <span>
                        {delegation.pendingResponse
                          ? "Response queued · Open child for delivery status"
                          : delegation.outcome === "result-available"
                            ? "Result available"
                            : delegation.outcome === "failed"
                              ? "Failed"
                              : delegation.outcome === "blocked"
                                ? "Completion unconfirmed"
                                : "Assignment active"}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
            {currentNudges.map(({ turn, followUp }) => {
              return (
                <div key={turn.id} className="border-t border-border/40 pt-1">
                  <p className={turn.failedAt ? "text-destructive" : "text-muted-foreground"}>
                    {turn.failedAt
                      ? turn.failureMessage
                      : (followUp.reason ??
                        (blockedByInteraction
                          ? "Waiting for the parent's approval or input."
                          : isWorking
                            ? "Available after the current response and any pending interaction."
                            : "Ready for the next safe opportunity."))}
                  </p>
                  {followUp.updates
                    .filter(
                      (report) =>
                        report.kind !== "decision-needed" ||
                        !children.some(
                          (child) => child.nudging?.delegation?.decision?.id === report.id,
                        ),
                    )
                    .map((report) => (
                      <ChildReportDetails
                        key={report.id}
                        report={report}
                        environmentId={thread.environmentId}
                      />
                    ))}
                  <div className="flex gap-1">
                    {turn.failedAt ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void dispatch({
                            type: "thread.queued-turn.update",
                            commandId: CommandId.make(crypto.randomUUID()),
                            threadId: thread.id,
                            queuedTurnId: turn.id,
                            text: turn.message.text,
                            updatedAt: new Date().toISOString(),
                          })
                        }
                      >
                        Retry delivery
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void dispatch({
                          type: "thread.queued-turn.delete",
                          commandId: CommandId.make(crypto.randomUUID()),
                          threadId: thread.id,
                          queuedTurnId: turn.id,
                          deletedAt: new Date().toISOString(),
                        })
                      }
                    >
                      Dismiss follow-up
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
