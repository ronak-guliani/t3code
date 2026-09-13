import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import type { RelayEnvironmentView } from "./useConnectionController";
import { CloudEnvironmentRows } from "./CloudEnvironmentRows";

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
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ThemedSwitch", () => ({
  ThemedSwitch: ({ value }: { value: boolean }) => (
    <input type="checkbox" checked={value} readOnly />
  ),
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
const render = () =>
  renderToStaticMarkup(
    <CloudEnvironmentRows
      connectedCloudEnvironments={[connected]}
      onReconnectEnvironment={() => {}}
    />,
  );

beforeEach(() => {
  harness.relayEnvironments = [registered];
  harness.identity = { accountId: "account" };
  harness.remove.mockReset();
});

describe("connected account environment actions", () => {
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
