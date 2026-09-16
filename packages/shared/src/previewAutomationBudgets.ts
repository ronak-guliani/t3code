import {
  DEFAULT_LOCATOR_CANDIDATE_LIMIT,
  DEFAULT_SNAPSHOT_MAX_CONSOLE_ENTRIES,
  DEFAULT_SNAPSHOT_MAX_INTERACTIVE_ELEMENTS,
  DEFAULT_SNAPSHOT_MAX_NETWORK_ENTRIES,
  DEFAULT_SNAPSHOT_MAX_SCREENSHOT_EDGE,
  DEFAULT_SNAPSHOT_MAX_VISIBLE_TEXT,
  PREVIEW_SNAPSHOT_FINAL_TEXT_BUDGET_BYTES,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationElement,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotInput,
} from "@t3tools/contracts";

export type ResolvedSnapshotBudgets = {
  includeConsole: boolean;
  includeNetwork: boolean;
  includeAccessibilityTree: boolean;
  consoleMode: "important" | "all";
  networkMode: "failed" | "all";
  maxVisibleText: number;
  maxInteractiveElements: number;
  maxScreenshotEdge: number;
  maxConsoleEntries: number;
  maxNetworkEntries: number;
};

export function resolveSnapshotBudgets(
  input: Pick<
    PreviewAutomationSnapshotInput,
    | "includeConsole"
    | "includeNetwork"
    | "includeAccessibilityTree"
    | "consoleMode"
    | "networkMode"
    | "maxVisibleText"
    | "maxInteractiveElements"
    | "maxScreenshotEdge"
    | "maxConsoleEntries"
    | "maxNetworkEntries"
  > = {},
): ResolvedSnapshotBudgets {
  return {
    includeConsole: input.includeConsole ?? true,
    includeNetwork: input.includeNetwork ?? true,
    includeAccessibilityTree: input.includeAccessibilityTree ?? false,
    consoleMode: input.consoleMode ?? "important",
    networkMode: input.networkMode ?? "failed",
    maxVisibleText: input.maxVisibleText ?? DEFAULT_SNAPSHOT_MAX_VISIBLE_TEXT,
    maxInteractiveElements:
      input.maxInteractiveElements ?? DEFAULT_SNAPSHOT_MAX_INTERACTIVE_ELEMENTS,
    maxScreenshotEdge: input.maxScreenshotEdge ?? DEFAULT_SNAPSHOT_MAX_SCREENSHOT_EDGE,
    maxConsoleEntries: input.maxConsoleEntries ?? DEFAULT_SNAPSHOT_MAX_CONSOLE_ENTRIES,
    maxNetworkEntries: input.maxNetworkEntries ?? DEFAULT_SNAPSHOT_MAX_NETWORK_ENTRIES,
  };
}

// CDP uses "warning"; some normalizers use "warn". Keep both.
const IMPORTANT_CONSOLE_LEVELS = new Set(["warn", "warning", "error", "assert"]);

const isConsoleErrorLevel = (level: string): boolean => level === "error" || level === "assert";

const isConsoleWarningLevel = (level: string): boolean => level === "warn" || level === "warning";

export function filterConsoleEntries(
  entries: ReadonlyArray<PreviewAutomationConsoleEntry>,
  budgets: Pick<ResolvedSnapshotBudgets, "includeConsole" | "consoleMode" | "maxConsoleEntries">,
): PreviewAutomationConsoleEntry[] {
  if (!budgets.includeConsole) {
    return [];
  }
  const filtered =
    budgets.consoleMode === "all"
      ? [...entries]
      : entries.filter((entry) => IMPORTANT_CONSOLE_LEVELS.has(entry.level));
  return filtered.slice(-budgets.maxConsoleEntries);
}

export function filterNetworkEntries(
  entries: ReadonlyArray<PreviewAutomationNetworkEntry>,
  budgets: Pick<ResolvedSnapshotBudgets, "includeNetwork" | "networkMode" | "maxNetworkEntries">,
): PreviewAutomationNetworkEntry[] {
  if (!budgets.includeNetwork) {
    return [];
  }
  const filtered =
    budgets.networkMode === "all"
      ? [...entries]
      : entries.filter(
          (entry) => entry.failed || (typeof entry.status === "number" && entry.status >= 400),
        );
  return filtered.slice(-budgets.maxNetworkEntries);
}

export function trimVisibleText(text: string, maxVisibleText: number): string {
  if (text.length <= maxVisibleText) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxVisibleText - 1))}…`;
}

export function limitInteractiveElements(
  elements: ReadonlyArray<PreviewAutomationElement>,
  maxInteractiveElements: number,
): PreviewAutomationElement[] {
  return elements.slice(0, maxInteractiveElements);
}

export function buildDiagnosticsSummary(input: {
  consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  interactiveElementCount: number;
  visibleTextLength: number;
}): string {
  const errors = input.consoleEntries.filter((e) => isConsoleErrorLevel(e.level));
  const warns = input.consoleEntries.filter((e) => isConsoleWarningLevel(e.level));
  const failedNet = input.networkEntries.filter(
    (e) => e.failed || (typeof e.status === "number" && e.status >= 400),
  );
  const parts = [
    `console: ${errors.length} error(s), ${warns.length} warn(s)`,
    `network: ${failedNet.length} failed/4xx+ of ${input.networkEntries.length}`,
    `interactive: ${input.interactiveElementCount}`,
    `visibleText: ${input.visibleTextLength} chars`,
  ];
  if (errors.length > 0) {
    parts.push(`latestError: ${truncateOneLine(errors[errors.length - 1]?.text ?? "", 120)}`);
  }
  if (failedNet.length > 0) {
    const last = failedNet[failedNet.length - 1];
    parts.push(
      `latestFailedRequest: ${last?.method ?? "GET"} ${truncateOneLine(last?.url ?? "", 100)} (${last?.status ?? "fail"})`,
    );
  }
  return parts.join(" | ");
}

function truncateOneLine(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}

export function applySnapshotBudgets(
  snapshot: PreviewAutomationSnapshot,
  budgets: ResolvedSnapshotBudgets,
): PreviewAutomationSnapshot {
  const consoleEntries = filterConsoleEntries(snapshot.consoleEntries, budgets);
  const networkEntries = filterNetworkEntries(snapshot.networkEntries, budgets);
  const interactiveElements = limitInteractiveElements(
    snapshot.interactiveElements,
    budgets.maxInteractiveElements,
  );
  const visibleText = trimVisibleText(snapshot.visibleText, budgets.maxVisibleText);
  const diagnosticsSummary = buildDiagnosticsSummary({
    consoleEntries,
    networkEntries,
    interactiveElementCount: interactiveElements.length,
    visibleTextLength: visibleText.length,
  });

  return {
    ...snapshot,
    visibleText,
    interactiveElements,
    accessibilityTree: budgets.includeAccessibilityTree ? snapshot.accessibilityTree : null,
    consoleEntries,
    networkEntries,
    diagnosticsSummary,
  };
}

const textEncoder = new TextEncoder();

const serializedByteLength = (value: unknown): number =>
  textEncoder.encode(JSON.stringify(value) ?? "").length;

/**
 * Enforce the final serialized-output ceiling on snapshot metadata (screenshot
 * bytes already stripped). Trims the largest diagnostics first and never
 * touches identity fields (`tabId`, `url`, `title`, `screenshot`,
 * `screenshotPath`, `error`). Returns the input unchanged when it fits.
 */
export function enforceFinalSnapshotTextBudget<T extends Record<string, unknown>>(
  metadata: T,
  maxBytes: number = PREVIEW_SNAPSHOT_FINAL_TEXT_BUDGET_BYTES,
): T {
  if (serializedByteLength(metadata) <= maxBytes) return metadata;
  const trimmed: Record<string, unknown> = { ...metadata, accessibilityTree: null };
  if (serializedByteLength(trimmed) <= maxBytes) return trimmed as T;
  const shrink = (overflow: number): boolean => {
    const visibleText = trimmed["visibleText"];
    if (typeof visibleText === "string" && visibleText.length > 0) {
      const keep = Math.max(0, visibleText.length - overflow - 128);
      trimmed["visibleText"] = keep > 0 ? `${visibleText.slice(0, keep)}…` : "";
      return true;
    }
    for (const key of ["consoleEntries", "networkEntries", "actionTimeline"] as const) {
      const entries = trimmed[key];
      if (Array.isArray(entries) && entries.length > 0) {
        trimmed[key] = entries.slice(Math.ceil(entries.length / 2));
        return true;
      }
    }
    const summary = trimmed["diagnosticsSummary"];
    if (typeof summary === "string" && summary.length > 0) {
      const keep = Math.max(0, summary.length - overflow - 64);
      trimmed["diagnosticsSummary"] = keep > 0 ? `${summary.slice(0, keep)}…` : "";
      return true;
    }
    return false;
  };
  let guard = 32;
  while (serializedByteLength(trimmed) > maxBytes && guard-- > 0) {
    if (!shrink(serializedByteLength(trimmed) - maxBytes)) break;
  }
  return trimmed as T;
}

export type LocatorCandidateSource = {
  role: string | null;
  name: string;
  selector: string;
  tag?: string;
};

/** Build Playwright-style locator candidates from interactive elements. */
export function candidateLocatorsFromElements(
  elements: ReadonlyArray<LocatorCandidateSource>,
  limit = DEFAULT_LOCATOR_CANDIDATE_LIMIT,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const el of elements) {
    if (out.length >= limit) {
      break;
    }
    const name = el.name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (el.role && name) {
      push(`role=${el.role}[name=${JSON.stringify(name)}]`);
    } else if (el.role) {
      push(`role=${el.role}`);
    }
    if (out.length >= limit) {
      break;
    }
    if (name) {
      push(`text=${JSON.stringify(name)}`);
    }
    if (out.length >= limit) {
      break;
    }
    if (el.selector) {
      push(el.selector);
    }
  }

  return out.slice(0, limit);
}
