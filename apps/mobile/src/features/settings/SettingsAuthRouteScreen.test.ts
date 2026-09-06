import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SettingsAuthRouteScreen } from "./SettingsAuthRouteScreen";

const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  nativeImports: vi.fn(),
  configured: false,
}));

vi.mock("@clerk/expo", () => ({ useAuth: vi.fn() }));
vi.mock("@clerk/expo/native", () => {
  state.nativeImports();
  throw new Error("Clerk native views are not linked in this build.");
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: state.dispatch }),
  StackActions: { replace: (name: string) => ({ type: "REPLACE", payload: { name } }) },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useLayoutEffect: (effect: () => void) => effect(),
}));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => state.configured }));

describe("SettingsAuthRouteScreen", () => {
  beforeEach(() => {
    state.configured = false;
    state.dispatch.mockClear();
  });

  it("keeps the sign-in route available in Connect builds", () => {
    state.configured = true;
    expect(SettingsAuthRouteScreen()).not.toBeNull();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("redirects without loading or rendering unlinked native authentication views", () => {
    expect(SettingsAuthRouteScreen()).toBeNull();
    expect(state.nativeImports).not.toHaveBeenCalled();
    expect(state.dispatch).toHaveBeenCalledWith({
      type: "REPLACE",
      payload: { name: "SettingsContent" },
    });
  });
});
