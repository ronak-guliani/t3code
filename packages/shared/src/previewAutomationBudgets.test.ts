import { describe, expect, it } from "vitest";

import {
  applySnapshotBudgets,
  candidateLocatorsFromElements,
  filterConsoleEntries,
  filterNetworkEntries,
  resolveSnapshotBudgets,
} from "./previewAutomationBudgets.ts";

describe("previewAutomationBudgets", () => {
  it("defaults budgets to context-safe sizes", () => {
    const budgets = resolveSnapshotBudgets({});
    expect(budgets.includeAccessibilityTree).toBe(false);
    expect(budgets.consoleMode).toBe("important");
    expect(budgets.networkMode).toBe("failed");
    expect(budgets.maxVisibleText).toBe(8_000);
    expect(budgets.maxInteractiveElements).toBe(80);
  });

  it("filters console to important levels", () => {
    const entries = [
      { level: "log", text: "a", timestamp: "t1" },
      { level: "warn", text: "b", timestamp: "t2" },
      { level: "error", text: "c", timestamp: "t3" },
    ];
    expect(
      filterConsoleEntries(entries, {
        includeConsole: true,
        consoleMode: "important",
        maxConsoleEntries: 10,
      }).map((e) => e.level),
    ).toEqual(["warn", "error"]);
  });

  it("filters network to failed and 4xx+", () => {
    const entries = [
      { url: "/ok", method: "GET", status: 200, failed: false, timestamp: "t1" },
      { url: "/nope", method: "GET", status: 404, failed: false, timestamp: "t2" },
      { url: "/boom", method: "POST", status: null, failed: true, timestamp: "t3" },
    ];
    expect(
      filterNetworkEntries(entries, {
        includeNetwork: true,
        networkMode: "failed",
        maxNetworkEntries: 10,
      }).map((e) => e.url),
    ).toEqual(["/nope", "/boom"]);
  });

  it("builds locator candidates", () => {
    expect(
      candidateLocatorsFromElements([
        { role: "button", name: "Send", selector: "button.submit", tag: "button" },
        { role: null, name: "", selector: "#q", tag: "input" },
      ]),
    ).toEqual(['role=button[name="Send"]', 'text="Send"', "button.submit", "#q"]);
  });

  it("applies snapshot budgets and diagnostics summary", () => {
    const snapshot = applySnapshotBudgets(
      {
        url: "https://example.com",
        title: "Example",
        loading: false,
        visibleText: "x".repeat(100),
        interactiveElements: Array.from({ length: 5 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `B${i}`,
          selector: `#b${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        accessibilityTree: { huge: true },
        consoleEntries: [
          { level: "log", text: "noise", timestamp: "t0" },
          { level: "error", text: "boom", timestamp: "t1" },
        ],
        networkEntries: [
          { url: "/ok", method: "GET", status: 200, failed: false, timestamp: "t0" },
          { url: "/bad", method: "GET", status: 500, failed: false, timestamp: "t1" },
        ],
        actionTimeline: [],
        screenshot: {
          mimeType: "image/png",
          data: "aa",
          width: 10,
          height: 10,
        },
      },
      resolveSnapshotBudgets({
        maxVisibleText: 10,
        maxInteractiveElements: 2,
      }),
    );

    expect(snapshot.visibleText.length).toBe(10);
    expect(snapshot.interactiveElements).toHaveLength(2);
    expect(snapshot.accessibilityTree).toBeNull();
    expect(snapshot.consoleEntries.map((e) => e.level)).toEqual(["error"]);
    expect(snapshot.networkEntries.map((e) => e.url)).toEqual(["/bad"]);
    expect(snapshot.diagnosticsSummary).toContain("console: 1 error");
    expect(snapshot.diagnosticsSummary).toContain("latestError: boom");
  });
});
