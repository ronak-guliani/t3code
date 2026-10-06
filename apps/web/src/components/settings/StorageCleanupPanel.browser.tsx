import "../../index.css";

import {
  EnvironmentId,
  type StorageCleanupPlan,
  type StorageExecuteCleanupInput,
  type StorageUsageSnapshot,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StorageUsagePanel } from "./StorageCleanupPanel";

const api = vi.hoisted(() => ({
  getUsage: vi.fn(),
  previewCleanup: vi.fn(),
  executeCleanup: vi.fn(),
}));

vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ storage: api }),
}));
vi.mock("../../environments/primary", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-local"),
}));

const GB = 1024 ** 3;
const usage: StorageUsageSnapshot = {
  status: "measuring",
  startedAt: "2026-10-04T12:00:00.000Z",
  completedAt: null,
  categories: [
    { category: "worktrees", status: "measuring", bytes: 412 * GB, items: 120 },
    { category: "providerLogs", status: "complete", bytes: 39 * GB, items: 3400 },
    {
      category: "database",
      status: "complete",
      bytes: 8.2 * GB,
      items: 1,
      reclaimableBytes: 3 * GB,
    },
  ],
  lowDisk: {
    active: true,
    thresholdPercent: 10,
    freePercent: 4,
    volumes: [{ path: "/Users/me", freeBytes: 40 * GB, totalBytes: 1000 * GB, freePercent: 4 }],
  },
  automaticCleanupEnabled: true,
  manualReview: [],
  cleanup: null,
};
const plan: StorageCleanupPlan = {
  planId: "plan-1",
  createdAt: "2026-10-04T12:00:00.000Z",
  expiresAt: "2026-10-04T12:30:00.000Z",
  items: [
    {
      id: "worktree:thread-a",
      category: "worktrees",
      description: 'Worktree of archived chat "Fix login"',
      target: "/ws/fix-login",
      estimatedBytes: 2 * GB,
      defaultSelected: true,
      needsManualReview: false,
    },
    {
      id: "database-backup:state.sqlite.before-x",
      category: "databaseBackups",
      description: "Database backup state.sqlite.before-x",
      target: "/state/state.sqlite.before-x",
      estimatedBytes: 4 * GB,
      defaultSelected: true,
      needsManualReview: false,
    },
    {
      id: "validation:/v/env-b/unknown",
      category: "validationEnvironments",
      description: "Validation environment needs manual review: no ownership record",
      target: "/v/env-b/unknown",
      estimatedBytes: 1024,
      defaultSelected: false,
      needsManualReview: true,
    },
  ],
  totals: [
    { category: "worktrees", items: 1, estimatedBytes: 2 * GB },
    { category: "databaseBackups", items: 1, estimatedBytes: 4 * GB },
    { category: "validationEnvironments", items: 1, estimatedBytes: 1024 },
  ],
  totalEstimatedBytes: 6 * GB + 1024,
  lowDisk: usage.lowDisk,
};

beforeEach(() => {
  api.getUsage.mockReset().mockResolvedValue(usage);
  api.previewCleanup.mockReset().mockResolvedValue(plan);
  api.executeCleanup.mockReset().mockImplementation(async (input: StorageExecuteCleanupInput) => ({
    planId: input.planId,
    startedAt: "2026-10-04T12:01:00.000Z",
    completedAt: "2026-10-04T12:01:05.000Z",
    bytesFreed: 4 * GB,
    results: [
      {
        itemId: "database-backup:state.sqlite.before-x",
        category: "databaseBackups",
        description: "Database backup state.sqlite.before-x",
        status: "removed",
        bytesFreed: 4 * GB,
        reason: "stale database backup",
      },
    ],
  }));
});

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StorageUsagePanel />
    </QueryClientProvider>,
  );
}

it("shows partial usage, low disk mode, and the APFS note", async () => {
  await renderPanel();
  await expect.element(page.getByText("Measuring… (partial results)")).toBeVisible();
  await expect
    .element(page.getByText("Low disk mode active (4.0% free)", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("412 GB")).toBeVisible();
  await expect.element(page.getByText("3.0 GB reclaimable")).toBeVisible();
  await expect.element(page.getByText("APFS clones", { exact: false })).toBeVisible();
});

it("previews by category, executes only the selected plan items, and shows the result", async () => {
  await renderPanel();
  await page.getByRole("button", { name: "Clean up now…" }).click();

  await expect.element(page.getByText('Worktree of archived chat "Fix login"')).toBeVisible();
  await expect.element(page.getByText("Needs manual review", { exact: true })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Clean up (frees ~6.0 GB)" });
  await expect.element(confirm).toBeEnabled();

  // Deselect a category; manual-review items stay unselected unless ticked.
  await page.getByRole("checkbox", { name: "Clean up Agent worktrees" }).click();
  await page.getByRole("button", { name: "Clean up (frees ~4.0 GB)" }).click();

  expect(api.executeCleanup).toHaveBeenCalledWith({
    planId: "plan-1",
    itemIds: ["database-backup:state.sqlite.before-x"],
  });
  await expect.element(page.getByText("Freed 4.0 GB · 1 removed · 0 skipped")).toBeVisible();
});
