import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { AppNavigationContext, useAppNavigation } from "./use-app-navigation";

const harness = vi.hoisted(() => ({ localNavigate: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.localNavigate }),
}));

describe("application navigation across independent sidebar chrome", () => {
  it("uses the outer navigator for subchat and parent routes inside a sidebar", () => {
    const navigate = vi.fn();
    let openSubchat = () => {};
    let openParent = () => {};
    function SidebarActions() {
      const navigation = useAppNavigation();
      openSubchat = () =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: { environmentId: "local", projectId: "project", parentThreadId: "parent" },
        });
      openParent = () =>
        navigation.navigate("Thread", { environmentId: "local", threadId: "parent" });
      return null;
    }
    renderToString(
      <AppNavigationContext value={{ navigate }}>
        <SidebarActions />
      </AppNavigationContext>,
    );
    openSubchat();
    openParent();
    expect(navigate).toHaveBeenNthCalledWith(1, "NewTaskSheet", {
      screen: "NewTaskDraft",
      params: { environmentId: "local", projectId: "project", parentThreadId: "parent" },
    });
    expect(navigate).toHaveBeenNthCalledWith(2, "Thread", {
      environmentId: "local",
      threadId: "parent",
    });
    expect(harness.localNavigate).not.toHaveBeenCalled();
  });

  it("retains normal screen navigation outside an independent sidebar", () => {
    let openParent = () => {};
    function ScreenActions() {
      const navigation = useAppNavigation();
      openParent = () =>
        navigation.navigate("Thread", { environmentId: "local", threadId: "parent" });
      return null;
    }
    renderToString(<ScreenActions />);
    openParent();
    expect(harness.localNavigate).toHaveBeenCalledWith("Thread", {
      environmentId: "local",
      threadId: "parent",
    });
  });
});
