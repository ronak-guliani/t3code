import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  useMarkRootThreadCompletionRead,
  useMarkThreadGroupNotificationsRead,
} from "./thread-hierarchy-controls";
import type { MobileThreadShell } from "./mobile-thread-hierarchy";
import { markRootThreadCompletionRead, seedRootThreadCompletionReadAt } from "./nested-thread-read";

const harness = vi.hoisted(() => ({
  focused: true,
  active: true,
  loaded: true,
  preferences: {
    threadChildNotificationReadAt: {} as Record<string, string>,
    threadCompletionReadAt: {} as Record<string, string>,
  },
  effects: [] as Array<() => void | (() => void)>,
  foreground: undefined as (() => void) | undefined,
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
function Group(props: { rows: typeof rows }) {
  useMarkThreadGroupNotificationsRead(props.rows);
  return null;
}
function Root() {
  useMarkRootThreadCompletionRead(rootThread);
  return null;
}
function mount() {
  renderToStaticMarkup(<Group rows={rows} />);
  return harness.effects.splice(0).map((effect) => effect());
}
beforeEach(() => {
  harness.focused = true;
  harness.active = true;
  harness.loaded = true;
  harness.preferences = {
    threadChildNotificationReadAt: {},
    threadCompletionReadAt: {},
  };
  harness.effects.length = 0;
  harness.foreground = undefined;
  harness.save.mockReset().mockImplementation((patch: typeof harness.preferences) => {
    harness.preferences = patch;
  });
});

describe("related group notification acknowledgement", () => {
  it("acknowledges every displayed group in one write and does not rewrite it", () => {
    const cleanup = mount();
    expect(harness.save).toHaveBeenCalledExactlyOnceWith({
      threadChildNotificationReadAt: { "local:parent": NOW, "local:child": NOW },
    });

    harness.foreground?.();
    mount();
    expect(harness.save).toHaveBeenCalledOnce();
    cleanup.forEach((dispose) => dispose?.());
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
    expect(harness.foreground).toBeUndefined();
  });
});
