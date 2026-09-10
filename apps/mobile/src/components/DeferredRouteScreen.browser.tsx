import { act, type ComponentType, type ReactNode, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createDeferredRouteScreen } from "./DeferredRouteScreen";
import { reportClientError } from "../lib/clientLogger";

vi.mock("../lib/clientLogger", () => ({ reportClientError: vi.fn() }));
vi.mock("./EmptyState", () => ({
  EmptyState: ({ actionLabel, onAction }: { actionLabel: string; onAction: () => void }) => (
    <button onClick={onAction}>{actionLabel}</button>
  ),
}));

type RouteProps = { readonly route: { readonly params: { readonly path: string } } };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(children: ReactNode) {
  await act(async () => root.render(children));
}

function FileScreen({ route }: RouteProps) {
  return <div data-testid="file">{route.params.path}</div>;
}

describe("deferred route React lifecycle (not native navigation)", () => {
  it("keeps the surrounding chrome mounted and forwards the latest pending route params", async () => {
    const gate = Promise.withResolvers<ComponentType<RouteProps>>();
    const load = vi.fn(() => gate.promise);
    const Deferred = createDeferredRouteScreen(load, "ThreadFile");
    const chromeMounted = vi.fn();
    const chromeUnmounted = vi.fn();
    function Chrome({ children }: { children: ReactNode }) {
      useLayoutEffect(() => {
        chromeMounted();
        return chromeUnmounted;
      }, []);
      return (
        <section>
          <header>Files</header>
          {children}
        </section>
      );
    }
    expect(load).not.toHaveBeenCalled();
    await render(
      <Chrome>
        <Deferred route={{ params: { path: "first.ts" } }} />
      </Chrome>,
    );
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector("header")?.textContent).toBe("Files");
    await render(
      <Chrome>
        <Deferred route={{ params: { path: "second.ts" } }} />
      </Chrome>,
    );

    await act(async () => gate.resolve(FileScreen));

    expect(container.querySelector('[data-testid="file"]')?.textContent).toBe("second.ts");
    expect(chromeMounted).toHaveBeenCalledTimes(1);
    expect(chromeUnmounted).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight load across mounts and StrictMode without sharing route props", async () => {
    const gate = Promise.withResolvers<ComponentType<RouteProps>>();
    const load = vi.fn(() => gate.promise);
    const Deferred = createDeferredRouteScreen(load, "ThreadFile");
    await render(
      <StrictMode>
        <Deferred route={{ params: { path: "one.ts" } }} />
        <Deferred route={{ params: { path: "two.ts" } }} />
      </StrictMode>,
    );
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve(FileScreen));
    expect(
      [...container.querySelectorAll('[data-testid="file"]')].map((node) => node.textContent),
    ).toEqual(["one.ts", "two.ts"]);
  });

  it("does not mount a screen after navigating away and reuses it on return", async () => {
    const gate = Promise.withResolvers<ComponentType<RouteProps>>();
    const load = vi.fn(() => gate.promise);
    const Deferred = createDeferredRouteScreen(load, "ThreadFile");
    const mounted = vi.fn();
    const Screen = (props: RouteProps) => {
      useLayoutEffect(mounted, []);
      return <FileScreen {...props} />;
    };
    await render(<Deferred route={{ params: { path: "old.ts" } }} />);
    await render(<div>Home</div>);
    await act(async () => gate.resolve(Screen));
    expect(mounted).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Home");

    await render(<Deferred route={{ params: { path: "return.ts" } }} />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toBe("return.ts");
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected load after navigating away and retries on return", async () => {
    const gate = Promise.withResolvers<ComponentType<RouteProps>>();
    const load = vi
      .fn<() => Promise<ComponentType<RouteProps>>>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(FileScreen);
    const Deferred = createDeferredRouteScreen(load, "ThreadFile");
    await render(<Deferred route={{ params: { path: "old.ts" } }} />);
    await render(<div>Home</div>);
    await act(async () => gate.reject(new Error("load failed")));
    expect(reportClientError).not.toHaveBeenCalled();
    await render(<Deferred route={{ params: { path: "return.ts" } }} />);
    expect(container.textContent).toBe("return.ts");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("load failed"), null, undefined])(
    "offers explicit recovery for a rejected module (%s)",
    async (cause) => {
      const load = vi
        .fn<() => Promise<ComponentType<RouteProps>>>()
        .mockRejectedValueOnce(cause)
        .mockResolvedValue(FileScreen);
      const Deferred = createDeferredRouteScreen(load, "ThreadFile");
      await render(<Deferred route={{ params: { path: "retry.ts" } }} />);
      const retry = container.querySelector("button");
      expect(retry?.textContent).toBe("Try again");
      expect(reportClientError).toHaveBeenCalledWith(
        "[deferred-route] ThreadFile module load failed",
        cause,
      );
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => retry?.click());
      expect(container.textContent).toBe("retry.ts");
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
});
