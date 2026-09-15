import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import type { RelayEnvironmentView } from "./useConnectionController";
import { CloudEnvironmentRows } from "./CloudEnvironmentRows";
import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";
import { AsyncResult } from "effect/unstable/reactivity";

const harness = vi.hoisted(() => ({
  relayEnvironments: [] as RelayEnvironmentView[],
  identity: { accountId: "account" } as { accountId: string } | null,
  remove: vi.fn(),
}));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isSignedIn: true }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "identity" ? harness.identity : null),
}));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: "identity" }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <button aria-label={accessibilityLabel}>{children}</button>,
  ActivityIndicator: () => null,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("react-native-reanimated", () => {
  const animation = { duration: () => animation };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    FadeIn: animation,
    FadeOut: animation,
    LinearTransition: animation,
  };
});
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    accessibilityLabel,
  }: {
    value: boolean;
    accessibilityLabel?: string;
  }) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} readOnly />,
}));
vi.mock("./ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../cloud/deregisterEnvironment", () => ({ deregisterEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useConnectionController", () => ({
  useConnectionController: () => ({
    relayEnvironments: harness.relayEnvironments,
    availableRelayEnvironments: [],
    relayDiscovery: { isRefreshing: false, error: null },
    removeEnvironment: harness.remove,
  }),
}));

const connected: ConnectedEnvironmentSummary = {
  environmentId: EnvironmentId.make("windows"),
  environmentLabel: "Windows laptop",
  displayUrl: "https://host.test",
  isRelayManaged: true,
  isEnabled: true,
  connectionState: "connected",
  connectionError: null,
  connectionErrorTraceId: null,
};
const registered: RelayEnvironmentView = {
  environment: {
    environmentId: connected.environmentId,
    label: connected.environmentLabel,
    endpoint: {
      httpBaseUrl: connected.displayUrl,
      wsBaseUrl: "wss://host.test",
      providerKind: "manual",
    },
    linkedAt: "2026-09-01T00:00:00.000Z",
  },
  availability: "online",
  status: null,
  error: null,
  traceId: null,
};
const render = (environment: ConnectedEnvironmentSummary = connected) =>
  renderToStaticMarkup(
    <CloudEnvironmentRows
      connectedCloudEnvironments={[environment]}
      onSetEnvironmentEnabled={() => {}}
      onRemoveEnvironment={() => {}}
    />,
  );

beforeEach(() => {
  harness.relayEnvironments = [registered];
  harness.identity = { accountId: "account" };
  harness.remove.mockReset();
});

describe("connected account environment actions", () => {
  it.each([true, false])("names direct and cloud switches when enabled=%s", (isEnabled) => {
    const environment = { ...connected, isEnabled };
    expect(render(environment)).toContain('aria-label="Enable Windows laptop"');
    const direct = renderToStaticMarkup(
      <ConnectionEnvironmentRow
        environment={{ ...environment, isRelayManaged: false }}
        expanded={false}
        onToggle={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onSetEnabled={() => {}}
        onUpdate={async () => AsyncResult.success(undefined)}
      />,
    );
    expect(direct).toContain('aria-label="Enable Windows laptop"');
  });
  it("keeps paused cloud rows with an unchecked switch and without stale errors", () => {
    const html = render({
      ...connected,
      isEnabled: false,
      connectionState: "error",
      connectionError: "stale failure",
      connectionErrorTraceId: "stale-trace",
    });
    expect(html).toContain("Windows laptop");
    expect(html).toContain("Off on this device");
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain("stale failure");
    expect(html).not.toContain("stale-trace");
    expect(harness.remove).not.toHaveBeenCalled();
  });
  it("removes deregistration after account refresh without removing the connected row", () => {
    expect(render()).toContain('aria-label="Deregister Windows laptop"');
    harness.relayEnvironments = [];
    const after = render();
    expect(after).not.toContain('aria-label="Deregister Windows laptop"');
    expect(after).toContain("Windows laptop");
    expect(after).toContain('checked=""');
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it("does not offer account actions when signed out", () => {
    harness.identity = null;
    expect(render()).not.toContain('aria-label="Deregister Windows laptop"');
  });
});
