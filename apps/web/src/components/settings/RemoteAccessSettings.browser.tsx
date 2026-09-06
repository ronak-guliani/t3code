import "../../index.css";

import type { RemoteAccessStatus } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RemoteAccessSettings } from "./RemoteAccessSettings";

vi.mock("../../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => path,
}));

afterEach(() => vi.unstubAllGlobals());

const failedShutdown: RemoteAccessStatus = {
  enabled: false,
  publicUrl: "https://t3.example.com",
  status: "error",
  message:
    "Disable saved, but the connector could not stop. Retry Disable or stop the host service.",
  checkedAt: null,
};

for (const initiallyFailed of [false, true]) {
  it(`retries shutdown without re-enabling after ${initiallyFailed ? "loading a failed shutdown" : "Disable fails"}`, async () => {
    let status: RemoteAccessStatus = initiallyFailed
      ? failedShutdown
      : { ...failedShutdown, enabled: true, status: "ready", message: "Ready to pair." };
    const actions: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
        if (options?.method !== "POST") return Response.json(status);
        if (typeof options.body !== "string") throw new Error("Expected JSON request body.");
        const body: unknown = JSON.parse(options.body);
        actions.push(body);
        if (!initiallyFailed && actions.length === 1) {
          status = failedShutdown;
          return Response.json({ error: failedShutdown.message }, { status: 400 });
        }
        status = { ...failedShutdown, status: "disabled", message: "Remote Access is disabled." };
        return Response.json(status);
      }),
    );
    await render(<RemoteAccessSettings />);
    if (!initiallyFailed) {
      await page.getByRole("button", { name: "Disable", exact: true }).click();
    }
    await expect
      .element(page.getByRole("button", { name: "Retry Disable", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Enable", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Pair remote device" })).toBeDisabled();
    await page.getByRole("button", { name: "Retry Disable", exact: true }).click();
    expect(actions).toEqual(
      initiallyFailed ? [{ action: "disable" }] : [{ action: "disable" }, { action: "disable" }],
    );
    await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    expect(actions.at(-1)).toEqual({ action: "enable" });
  });
}
