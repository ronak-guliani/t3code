import {
  isToolLifecycleItemType,
  type AssetResource,
  type ThreadId,
  type ToolActivitySource,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export interface WorkLogPresentationEntry {
  readonly requestId?: string;
  readonly label: string;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
  readonly toolSource?: ToolActivitySource;
}

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  const status = payload?.status;
  if (status === "idle" && payload?.taskType === "subagent_batch") return "stopped";
  if (status === "pending" || status === "running" || status === "waiting") return "inProgress";
  if (status === "cancelled" || status === "interrupted") return "stopped";
  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  )
    return status;
  return undefined;
}

/** Compact labels never substitute command output for the action being performed. */
export function compactWorkEntryLabel(entry: WorkLogPresentationEntry): string {
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  const running = entry.toolLifecycleStatus === "inProgress";
  const status = entry.toolLifecycleStatus;
  const verb = (active: string, complete: string) =>
    status === "failed"
      ? "Failed"
      : status === "declined"
        ? "Declined"
        : status === "stopped"
          ? "Stopped"
          : running
            ? active
            : complete;
  const action = toolGroupAction(entry);
  const data = asRecord(entry.toolData);
  const input = asRecord(data?.rawInput) ?? asRecord(asRecord(data?.item)?.input);
  const path =
    entry.changedFiles?.[0] ??
    entry.viewedImagePath ??
    nonEmptyString(input?.path) ??
    nonEmptyString(input?.file_path) ??
    entry.detail;
  const filename = path && !/[\r\n]/.test(path) ? path.trim().split(/[/\\]/).at(-1) : undefined;
  if (action === "read") return `${verb("Reading", "Read")} ${filename || "file"}`;
  if (action === "edit") return `${verb("Editing", "Edited")} ${filename || "files"}`;
  if (action === "command") {
    const program = commandProgramName(entry.command ?? "");
    return `${verb("Running", "Ran")} ${program && !/^(?:bash|zsh|sh|fish):$/.test(program) ? program : "command"}`;
  }
  if (action === "skill") {
    const name = /Skill\s*[-:]\s*["']?([^"'\n]+)/i.exec(entry.detail ?? "")?.[1]?.trim();
    return `${verb("Loading", "Loaded")} ${name || "skill"}`;
  }
  return normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
}

export function workEntryNeedsAttention(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  );
}

export function workGroupAccessibleLabel(label: string, activeCount: number): string {
  return activeCount > 1 ? `${label}, ${activeCount - 1} more active` : label;
}

export function deriveWorkGroupActivity<T extends WorkLogPresentationEntry>(
  entries: readonly T[],
  isWorking: boolean,
) {
  const resolvedRequests = new Set(
    entries
      .filter(
        (entry) =>
          (entry.sourceActivityKind === "approval.resolved" ||
            entry.sourceActivityKind === "user-input.resolved") &&
          entry.requestId,
      )
      .map((entry) => entry.requestId),
  );
  const approval = entries.find(
    (entry) =>
      (entry.sourceActivityKind === "approval.requested" ||
        entry.sourceActivityKind === "user-input.requested") &&
      (!entry.requestId || !resolvedRequests.has(entry.requestId)),
  );
  const failed = entries.findLast(workEntryNeedsAttention);
  const stopped = entries.findLast(
    (entry) =>
      entry.toolLifecycleStatus === "stopped" ||
      (!isWorking && entry.toolLifecycleStatus === "inProgress"),
  );
  const active = isWorking
    ? entries.filter((entry) => entry.toolLifecycleStatus === "inProgress")
    : [];
  // Keep the oldest still-running call in the lead slot; parallel starts don't rotate it.
  const lead = approval ?? failed ?? active[0];
  const state = approval
    ? "approval"
    : failed
      ? "failed"
      : active.length > 0
        ? "active"
        : stopped
          ? "stopped"
          : "complete";
  const failureLabel = failed ? compactWorkEntryLabel(failed) : null;
  return {
    state,
    lead,
    activeCount: active.length,
    shimmer: state === "active",
    label: approval
      ? approval.sourceActivityKind === "user-input.requested"
        ? "Input needed"
        : "Approval needed"
      : failureLabel
        ? /^(failed|declined)\b/i.test(failureLabel)
          ? failureLabel
          : `Failed: ${failureLabel}`
        : active[0]
          ? compactWorkEntryLabel(active[0])
          : stopped
            ? compactWorkEntryLabel({ ...stopped, toolLifecycleStatus: "stopped" })
            : (entries.length === 1
                ? compactWorkEntryLabel(entries[0]!)
                : summarizeToolGroup(entries)) || "Work log",
  } as const;
}

/** Only adjacent successful actions group; attention and live rows remain individually visible. */
export function groupConsecutiveWorkEntries<T>(
  entries: readonly T[],
  entryFor: (entry: T) => WorkLogPresentationEntry,
): { entries: T[]; label: string }[] {
  const groups: { entries: T[]; label: string; key: string | null }[] = [];
  for (const entry of entries) {
    const work = entryFor(entry);
    const action = toolGroupAction(work);
    const key =
      !workEntryNeedsAttention(work) &&
      work.toolLifecycleStatus !== "inProgress" &&
      work.toolLifecycleStatus !== "stopped" &&
      action !== "update" &&
      work.tone !== "thinking"
        ? `${action}:${action === "other" ? (work.toolTitle ?? work.label) : ""}:${work.toolSource?.key ?? ""}`
        : null;
    const previous = groups.at(-1);
    if (key !== null && previous?.key === key) previous.entries.push(entry);
    else groups.push({ entries: [entry], label: "", key });
  }
  return groups.map((group) => ({
    entries: group.entries,
    label: summarizeToolGroup(group.entries.map(entryFor)),
  }));
}

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "browser"
  | "code-search"
  | "search"
  | "skill"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | ToolGroupAction
  | "dynamic-tool"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

const T3_MCP_TOOL_LABELS: Record<
  string,
  readonly [action: string, running: string, completed: string, detail: string]
> = {
  orchestrator_capabilities: ["Get", "Getting", "Got", "orchestration capabilities"],
  delegate_task: ["Delegate", "Delegating", "Delegated", "a child task"],
  task_status: ["Get", "Getting", "Got", "delegated task status"],
  task_cancel: ["Cancel", "Canceling", "Canceled", "delegated task"],
  schedule_task: ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
  list_scheduled_tasks: ["List", "Listing", "Listed", "scheduled tasks"],
  update_scheduled_task: ["Update", "Updating", "Updated", "a scheduled task"],
  delete_scheduled_task: ["Delete", "Deleting", "Deleted", "a scheduled task"],
  create_threads: ["Create", "Creating", "Created", "T3 threads"],
  t3_thread_start: ["Start", "Starting", "Started", "a T3 thread"],
  t3_thread_list: ["List", "Listing", "Listed", "T3 threads"],
  t3_thread_read: ["Read", "Reading", "Read", "a T3 thread"],
  t3_thread_send: ["Send", "Sending", "Sent", "to a T3 thread"],
  t3_thread_wait: ["Wait", "Waiting", "Waited", "for a T3 thread"],
  t3_thread_interrupt: ["Interrupt", "Interrupting", "Interrupted", "a T3 thread"],
  t3_worktree_handoff: ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
  t3_worktree_status: ["Get", "Getting", "Got", "thread worktree status"],
  preview_status: ["Get", "Getting", "Got", "preview browser status"],
  preview_open: ["Open", "Opening", "Opened", "a page in the preview browser"],
  preview_navigate: ["Navigate", "Navigating", "Navigated", "the preview browser"],
  preview_snapshot: [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  preview_click: ["Click", "Clicking", "Clicked", "in the preview browser"],
  preview_press: ["Press", "Pressing", "Pressed", "a key in the preview browser"],
  preview_type: ["Type", "Typing", "Typed", "in the preview browser"],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  preview_resize: ["Resize", "Resizing", "Resized", "the preview browser"],
  preview_evaluate: ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for the preview page"],
  preview_set_appearance: ["Set", "Setting", "Set", "preview browser appearance"],
  preview_recording_start: ["Start", "Starting", "Started", "recording the preview browser"],
  preview_recording_stop: ["Stop", "Stopping", "Stopped", "recording the preview browser"],
};

function resolveT3McpToolPresentation(value: string | undefined, status: string | undefined) {
  if (!value) return null;
  const name = normalizeCompactToolLabel(value).replace(
    /^(?:mcp__(?:t3-code|t3_code|t3code)__|(?:t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*))/i,
    "",
  );
  if (!Object.hasOwn(T3_MCP_TOOL_LABELS, name)) return null;

  const [action, running, completed, detail] = T3_MCP_TOOL_LABELS[name]!;
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;

  return {
    displayName: `${verb} ${detail}`,
    icon: name.startsWith("preview_") ? ("browser" as const) : ("t3-code" as const),
  };
}

/** Latest live activity stays present-tense unless the call itself failed, declined, or stopped. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped") return status;
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** Resolves tool identity before choosing labels or icons in either client. */
export function resolveWorkEntryToolPresentation(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "toolLifecycleStatus">,
  fallbackStatus?: "inProgress" | "completed",
) {
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  const data = entry.toolData;
  if (data !== null && typeof data === "object") {
    if (
      "server" in data &&
      typeof data.server === "string" &&
      "tool" in data &&
      typeof data.tool === "string"
    ) {
      return resolveT3McpToolPresentation(`${data.server}.${data.tool}`, status);
    }
    if ("toolName" in data && typeof data.toolName === "string") {
      return resolveT3McpToolPresentation(data.toolName, status);
    }
  }

  return (
    resolveT3McpToolPresentation(entry.toolTitle, status) ??
    resolveT3McpToolPresentation(entry.label, status)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const mergedToolDataCache = new WeakMap<object, WeakMap<object, Record<string, unknown>>>();

export function mergeWorkLogToolData(previous: unknown, next: unknown): unknown {
  const before = asRecord(previous);
  const after = asRecord(next);
  if (!before || !after) return next ?? previous;
  // Activity payloads are immutable. Re-deriving history must preserve merged
  // payload identity so an unrelated append doesn't invalidate every tool row.
  const cached = mergedToolDataCache.get(before)?.get(after);
  if (cached) return cached;
  const beforeItem = asRecord(before.item);
  const afterItem = asRecord(after.item);
  const merged = {
    ...before,
    ...after,
    ...(beforeItem && afterItem ? { item: { ...beforeItem, ...afterItem } } : {}),
  };
  const byNext = mergedToolDataCache.get(before) ?? new WeakMap<object, Record<string, unknown>>();
  byNext.set(after, merged);
  mergedToolDataCache.set(before, byNext);
  return merged;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

export function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved" ||
    entry.sourceActivityKind === "provider.approval.respond.failed"
  ) {
    return "update";
  }
  if (resolveWorkEntryToolPresentation(entry)?.icon === "browser") return "browser";
  const title = normalizeCompactToolLabel(entry.toolTitle ?? entry.label).toLowerCase();
  if (/^skill\b/.test(title) || /^Skill\s*[-:]/i.test(entry.detail ?? "")) return "skill";
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    entry.viewedImagePath !== undefined ||
    /^(read|reading|view|viewing) (file|image)\b/.test(title) ||
    (entry.itemType === "dynamic_tool_call" &&
      entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "skill":
      return `Loaded ${count} ${count === 1 ? "skill" : "skills"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "browser":
      return `Used browser ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const sources = new Map<string, ToolActivitySource>();
  const groupedEntries = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  for (const entry of summaryEntries) {
    if (entry.toolSource) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = sourceValues.map((source) => source.name);
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";

  const action = actions.values().next().value!;
  if (action !== "other") return action;

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}
