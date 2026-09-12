import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  useMarkRootThreadCompletionRead,
  useMarkThreadGroupNotificationsRead,
  useSeedRootThreadCompletionReadAt,
} from "./thread-hierarchy-controls";
import { resetAppStateSubscriptionForTests } from "../../lib/appForeground";
import type { MobileThreadShell } from "./mobile-thread-hierarchy";
import { markRootThreadCompletionRead, seedRootThreadCompletionReadAt } from "./nested-thread-read";
import { resolveThreadListV2Status } from "./threadListV2";
import { ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION } from "../../state/thread-completion-read-migration";

const harness = vi.hoisted(() => ({
  focused: true,
  active: true,
  loaded: true,
  preferences: {
    threadChildNotificationReadAt: {} as Record<string, string>,
    threadCompletionReadAt: {} as Record<string, string>,
    threadCompletionReadAtMigrationVersion: undefined as number | undefined,
  },
  shellStatuses: new Map<EnvironmentId, EnvironmentShellStatus>([
    ["local" as EnvironmentId, "live"],
  ]),
  effects: [] as Array<() => void | (() => void)>,
  foreground: undefined as (() => void) | undefined,
  subscribeCalls: 0,
  save: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    harness.loaded ? AsyncResult.success(harness.preferences) : AsyncResult.initial(),
  useAtomSet: () => harness.save,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => harness.focused }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.active ? "active" : "background";
    },
    addEventListener: (_event: string, callback: () => void) => {
      harness.subscribeCalls += 1;
      harness.foreground = callback;
      return {
        remove: () => {
          harness.foreground = undefined;
        },
      };
    },
  },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => (harness.loaded ? AsyncResult.success(harness.preferences) : AsyncResult.initial()),
  },
}));

const NOW = "2026-09-06T20:00:00.000Z";
const LATER = "2026-09-06T21:00:00.000Z";
const rows = [
  { threadKey: "local:parent", latestRelatedNotificationAt: NOW },
  { threadKey: "local:child", latestRelatedNotificationAt: NOW },
  { threadKey: "local:leaf", latestRelatedNotificationAt: null },
];
const rootThread = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("root"),
  parentThreadId: null,
  virtualAgentRun: undefined,
  latestTurn: { completedAt: NOW },
} as MobileThreadShell;
const legacyRootThread = { ...rootThread, parentThreadId: undefined } as MobileThreadShell;
const runningRootThread = {
  ...rootThread,
  latestTurn: {
    turnId: "turn-running",
    state: "running",
    startedAt: NOW,
    completedAt: null,
  },
} as MobileThreadShell;
const completedRootThread = {
  ...runningRootThread,
  latestTurn: { ...runningRootThread.latestTurn, state: "completed", completedAt: LATER },
} as MobileThreadShell;
function Group(props: { rows: typeof rows }) {
  useMarkThreadGroupNotificationsRead(props.rows);
  return null;
}
function Root() {
  useMarkRootThreadCompletionRead(rootThread);
  return null;
}
function Seed(props: { readonly threads: readonly MobileThreadShell[] }) {
  useSeedRootThreadCompletionReadAt(props.threads, harness.shellStatuses);
  return null;
}
function mount() {
  renderToStaticMarkup(<Group rows={rows} />);
  return harness.effects.splice(0).map((effect) => effect());
}
beforeEach(() => {
  resetAppStateSubscriptionForTests();
  harness.focused = true;
  harness.active = true;
  harness.loaded = true;
  harness.preferences = {
    threadChildNotificationReadAt: {},
    threadCompletionReadAt: {},
    threadCompletionReadAtMigrationVersion: undefined,
  };
  harness.shellStatuses = new Map([["local" as EnvironmentId, "live"]]);
  harness.effects.length = 0;
  harness.foreground = undefined;
  harness.subscribeCalls = 0;
  harness.save.mockReset().mockImplementation((patch: typeof harness.preferences) => {
    harness.preferences = patch;
  });
});

describe("related group notification acknowledgement", () => {
  it("acknowledges every displayed group in one write and does not rewrite it", () => {
    const firstCleanup = mount();
    expect(harness.save).toHaveBeenCalledExactlyOnceWith({
      threadChildNotificationReadAt: { "local:parent": NOW, "local:child": NOW },
    });

    harness.foreground?.();
    const secondCleanup = mount();
    expect(harness.save).toHaveBeenCalledOnce();
    // Every mounted hook shares one native AppState listener.
    expect(harness.subscribeCalls).toBe(1);
    firstCleanup.forEach((dispose) => dispose?.());
    secondCleanup.forEach((dispose) => dispose?.());
    expect(harness.foreground).toBeUndefined();
  });

  it("keeps newer and unrelated stamps rather than overwriting them", () => {
    harness.preferences.threadChildNotificationReadAt = {
      "local:child": LATER,
      "remote:child": LATER,
    };
    mount();
    expect(harness.preferences.threadChildNotificationReadAt).toEqual({
      "local:parent": NOW,
      "local:child": LATER,
      "remote:child": LATER,
    });
  });

  describe("root completion acknowledgement", () => {
    it("records the completion timestamp only while focused and active", () => {
      renderToStaticMarkup(<Root />);
      const cleanup = harness.effects.splice(0).map((effect) => effect());
      expect(harness.preferences.threadCompletionReadAt).toEqual({ "local:root": NOW });
      cleanup.forEach((dispose) => dispose?.());
    });

    it("does not rewrite a newer completion marker", () => {
      harness.preferences.threadCompletionReadAt = { "local:root": LATER };
      renderToStaticMarkup(<Root />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences.threadCompletionReadAt).toEqual({ "local:root": LATER });
    });

    it("accepts legacy roots whose parent id is omitted", () => {
      const save = vi.fn();
      markRootThreadCompletionRead(legacyRootThread, { threadCompletionReadAt: {} }, save);
      expect(save).toHaveBeenCalledWith({
        threadCompletionReadAt: { "local:root": NOW },
      });
    });

    it("seeds missing root receipts without overwriting existing values", () => {
      expect(seedRootThreadCompletionReadAt([legacyRootThread], {})).toEqual({
        "local:root": NOW,
      });
      expect(seedRootThreadCompletionReadAt([legacyRootThread], { "local:root": LATER })).toEqual({
        "local:root": LATER,
      });
    });

    it("seeds upgrade receipts once, then leaves a newly completed root unread", () => {
      renderToStaticMarkup(<Seed threads={[runningRootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences).toMatchObject({
        threadCompletionReadAt: {},
        threadCompletionReadAtMigrationVersion: ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION,
      });

      renderToStaticMarkup(<Seed threads={[completedRootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences.threadCompletionReadAt).toEqual({});
      expect(resolveThreadListV2Status(completedRootThread)).toBe("completed");

      markRootThreadCompletionRead(completedRootThread, harness.preferences, harness.save);
      expect(resolveThreadListV2Status(completedRootThread, LATER)).toBe("ready");
    });

    it("waits for every environment to become live before seeding", () => {
      harness.shellStatuses = new Map([
        ["local" as EnvironmentId, "live"],
        ["remote" as EnvironmentId, "synchronizing"],
      ]);
      renderToStaticMarkup(<Seed threads={[runningRootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences.threadCompletionReadAtMigrationVersion).toBeUndefined();

      harness.shellStatuses = new Map([
        ["local" as EnvironmentId, "live"],
        ["remote" as EnvironmentId, "live"],
      ]);
      renderToStaticMarkup(<Seed threads={[runningRootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences.threadCompletionReadAtMigrationVersion).toBe(
        ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION,
      );
    });

    it("seeds roots completed before migration exactly once", () => {
      renderToStaticMarkup(<Seed threads={[rootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences).toMatchObject({
        threadCompletionReadAt: { "local:root": NOW },
        threadCompletionReadAtMigrationVersion: ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION,
      });

      harness.preferences.threadCompletionReadAt = {};
      renderToStaticMarkup(<Seed threads={[rootThread]} />);
      harness.effects.splice(0).forEach((effect) => effect());
      expect(harness.preferences.threadCompletionReadAt).toEqual({});
    });
  });

  it("waits for foreground and reads the latest persisted values on resume", () => {
    harness.active = false;
    mount();
    expect(harness.save).not.toHaveBeenCalled();
    harness.preferences.threadChildNotificationReadAt = { "remote:new": LATER };
    harness.active = true;
    harness.foreground?.();
    expect(harness.preferences.threadChildNotificationReadAt).toEqual({
      "local:parent": NOW,
      "local:child": NOW,
      "remote:new": LATER,
    });
  });

  it.each(["focused", "loaded"] as const)("does not acknowledge while %s is false", (key) => {
    harness[key] = false;
    mount();
    expect(harness.save).not.toHaveBeenCalled();
    // The shared foreground listener stays mounted but its guard refuses.
    harness.foreground?.();
    expect(harness.save).not.toHaveBeenCalled();
  });
});
