import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { removedThreadProject } from "./threadSelectionLifecycle";

const thread: EnvironmentThreadShell = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("child"),
  parentThreadId: ThreadId.make("parent"),
  projectId: ProjectId.make("project"),
  title: "Child",
  modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  session: null,
  createdAt: "2026-09-05T12:00:00Z",
  updatedAt: "2026-09-05T12:00:00Z",
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasPendingQueuedTurn: false,
  hasActionableProposedPlan: false,
};
const input = {
  route: { environmentId: thread.environmentId, threadId: thread.id },
  shell: null,
  detail: thread,
  previous: thread,
  shellStatus: "live" as const,
};

describe("selected nested thread lifecycle", () => {
  it("leaves an archived subtree when shell removal precedes the detail event", () => {
    expect(removedThreadProject(input)).toEqual({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
  });
  it("does not confuse reconnects or not-yet-visible creation with removal", () => {
    expect(removedThreadProject({ ...input, shellStatus: "synchronizing" })).toBeNull();
    expect(removedThreadProject({ ...input, shellStatus: "cached" })).toBeNull();
    expect(removedThreadProject({ ...input, previous: null })).toBeNull();
    expect(removedThreadProject({ ...input, shell: thread })).toBeNull();
  });
  it("does not apply the previous route's removal to another chat or environment", () => {
    expect(
      removedThreadProject({
        ...input,
        route: { ...input.route, threadId: ThreadId.make("other") },
      }),
    ).toBeNull();
    expect(
      removedThreadProject({
        ...input,
        route: { ...input.route, environmentId: EnvironmentId.make("remote") },
      }),
    ).toBeNull();
  });
  it("leaves a directly opened archived detail even without a prior live shell", () => {
    expect(
      removedThreadProject({
        ...input,
        previous: null,
        detail: { ...thread, archivedAt: thread.updatedAt },
      }),
    ).toEqual({ environmentId: thread.environmentId, projectId: thread.projectId });
  });
});
