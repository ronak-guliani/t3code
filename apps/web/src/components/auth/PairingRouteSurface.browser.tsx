import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetServerAuthBootstrapForTests } from "../../environments/primary";
import { PairingRouteSurface } from "./PairingRouteSurface";

describe("PairingRouteSurface", () => {
  const auth = {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "t3_session",
  } as const;

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, document.title, "/");
    __resetServerAuthBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("auto-pairs from /pair and removes the one-time credential from browser history", async () => {
    window.history.replaceState({}, document.title, "/pair#token=browser-pairing-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-08-02T00:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const onAuthenticated = vi.fn();

    await render(
      <PairingRouteSurface
        auth={{
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    await expect
      .element(page.getByRole("heading", { name: "Pair with this environment" }))
      .toBeVisible();
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/bootstrap`,
      expect.objectContaining({
        body: JSON.stringify({ credential: "browser-pairing-secret" }),
        credentials: "include",
        method: "POST",
      }),
    );
    expect(window.location.pathname).toBe("/pair");
    expect(window.location.hash).toBe("");
  });

  it("accepts a pasted link, masks it, and submits only its token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ authenticated: true, sessionMethod: "browser-session-cookie" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const onAuthenticated = vi.fn();
    await render(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);
    const input = page.getByLabelText("Pairing token");
    await expect.element(input).toHaveAttribute("type", "password");
    await input.fill(`${window.location.origin}/pair#token=manual-test-secret`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/bootstrap`,
      expect.objectContaining({ body: JSON.stringify({ credential: "manual-test-secret" }) }),
    );
    await expect.element(input).toHaveValue("");
  });

  it("rejects another environment without submitting or exposing the credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const onAuthenticated = vi.fn();
    await render(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);
    const input = page.getByLabelText("Pairing token");
    await input.fill("https://other-environment.test/pair#token=wrong-environment-secret");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("different environment");
    await expect.element(input).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("clears a rejected token and leaves an accessible retry error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid bootstrap credential." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await render(<PairingRouteSurface auth={auth} onAuthenticated={vi.fn()} />);
    const input = page.getByLabelText("Pairing token");
    await input.fill("consumed-test-secret");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Invalid pairing token");
    await expect.element(input).toHaveValue("");
    await expect.element(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  });
});
