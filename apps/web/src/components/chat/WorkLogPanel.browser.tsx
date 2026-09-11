import "../../index.css";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { WorkLogPanel } from "./WorkLogPanel";

describe("WorkLogPanel", () => {
  it("defers untouched output, retains visited content, and handles interrupted transitions", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Details({ revision }: { revision: number }) {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <button data-revision={revision}>Copy full output</button>;
    }
    const content = (open: boolean, revision = 0) => (
      <Collapsible open={open}>
        <CollapsibleTrigger>Work history</CollapsibleTrigger>
        <WorkLogPanel open={open}>
          <Details revision={revision} />
        </WorkLogPanel>
      </Collapsible>
    );
    const screen = await render(content(false));
    try {
      expect(mounted).not.toHaveBeenCalled();
      await expect.element(page.getByText("Copy full output")).not.toBeInTheDocument();
      await screen.rerender(content(true));
      const output = page.getByRole("button", { name: "Copy full output" });
      await expect.element(output).toBeVisible();
      const originalNode = output.element();
      for (const open of [false, true, false, true, false]) {
        await screen.rerender(content(open));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await expect.element(page.getByText("Copy full output")).not.toBeVisible();
      expect(originalNode.isConnected).toBe(true);
      expect(originalNode.closest("[data-slot='collapsible-panel']")?.hasAttribute("hidden")).toBe(
        true,
      );
      await screen.rerender(content(false, 1));
      expect(originalNode.getAttribute("data-revision")).toBe("0");
      await screen.rerender(content(true, 1));
      await expect.element(output).toBeVisible();
      expect(originalNode.getAttribute("data-revision")).toBe("1");
      expect(output.element()).toBe(originalNode);
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(unmounted).not.toHaveBeenCalled();
      const trigger = page.getByRole("button", { name: "Work history" }).element();
      expect(trigger.getAttribute("aria-controls")).toBe(
        originalNode.closest("[data-slot='collapsible-panel']")?.id,
      );
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await screen.unmount();
    }
    expect(unmounted).toHaveBeenCalledTimes(1);
  });
});
