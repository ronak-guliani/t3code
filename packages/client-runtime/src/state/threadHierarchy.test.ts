import { describe, expect, it } from "vite-plus/test";
import {
  buildThreadTree,
  flattenThreadTree,
  normalizeParentThreadKeys,
  selectVisibleThreads,
  hasUnseenChildNotification,
} from "./threadHierarchy.ts";

function thread(id: string, parentThreadId: string | null = null, environmentId = "local") {
  return { id, parentThreadId, environmentId, archivedAt: null as string | null };
}

describe("shared thread hierarchy", () => {
  it("retains child updates until a visit acknowledges the durable notification timestamp", () => {
    const latestChildNotificationAt = "2026-09-05T12:00:00Z";
    expect(hasUnseenChildNotification({ latestChildNotificationAt })).toBe(true);
    expect(
      hasUnseenChildNotification({
        latestChildNotificationAt,
        lastVisitedAt: latestChildNotificationAt,
      }),
    ).toBe(false);
    expect(
      hasUnseenChildNotification({
        latestChildNotificationAt,
        lastVisitedAt: "2026-09-05T11:00:00Z",
      }),
    ).toBe(true);
    expect(hasUnseenChildNotification({ latestChildNotificationAt: "invalid" })).toBe(false);
  });
  it("scopes parentage and breaks self, missing and cyclic references", () => {
    const parents = normalizeParentThreadKeys([
      thread("root"),
      thread("child", "root"),
      thread("root", null, "remote"),
      thread("orphan", "child", "remote"),
      thread("self", "self"),
      thread("a", "b"),
      thread("b", "a"),
    ]);
    expect(parents.get("local:child")).toBe("local:root");
    expect(parents.has("remote:orphan")).toBe(false);
    expect(parents.has("local:self")).toBe(false);
    expect(parents.has("local:a") && parents.has("local:b")).toBe(false);
  });

  it("hides an archived subtree before orphan normalization", () => {
    expect(
      selectVisibleThreads([
        thread("leaf", "child"),
        thread("child", "root"),
        { ...thread("root"), archivedAt: "2026-09-05T00:00:00Z" },
        thread("other"),
      ]).map((node) => node.id),
    ).toEqual(["other"]);
  });

  it("builds and expands a 12,000-level hierarchy without recursive stack overflow", () => {
    const threads = Array.from({ length: 12_000 }, (_, index) =>
      thread(String(index), index === 0 ? null : String(index - 1)),
    );
    const tree = buildThreadTree({
      threads,
      compare: () => 0,
      resolveStatus: () => false,
      rollUpStatus: (statuses) => statuses.some(Boolean),
      isArchiveBlocked: () => false,
    });
    const rows = flattenThreadTree({
      nodes: tree,
      expandedOverrideByThreadKey: new Map(),
      activeThreadKey: "local:11999",
      isActiveStatus: Boolean,
    });
    expect(rows).toHaveLength(12_000);
    expect(rows[0]?.childCount).toBe(11_999);
    expect(rows.at(-1)?.depth).toBe(11_999);
  });
});
