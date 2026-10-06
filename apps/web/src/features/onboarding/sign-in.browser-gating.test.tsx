import { act, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { onboardingStore } from "./store";

afterEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  location.hash = "";
});
it.each([
  "auth-code:session:UNKNOWN",
  "auth-code:rejected:UNKNOWN",
  "host-complete:rejected:UNAUTHORIZED",
])("replaces pending status with recovery for %s", async (error) => {
  onboardingStore.setState(() => ({
    createdBotId: null,
    signIn: {
      id: "attempt",
      intent: "signin",
      status: "pending",
      outcome: null,
    },
  }));
  const app = await renderApp("/onboarding/connect", { onboarded: false });
  try {
    expect(await screen.findByText("Connecting your account…")).toBeTruthy();
    expect(screen.queryByText("Waiting for sign-in…")).toBeNull();
    expect(screen.queryByText("Sign in another way")).toBeNull();
    expect(
      screen.getByText(/Connecting the account signed in on this site/)
    ).toBeTruthy();
    location.hash = "#/onboarding/connect";
    await act(async () =>
      onboardingStore.setState((state) => ({
        ...state,
        signIn: {
          ...state.signIn!,
          status: "failed",
          outcome: { ok: false, error },
        },
      }))
    );
    expect(screen.queryByText("Connecting your account…")).toBeNull();
    expect(screen.queryByText("Waiting for sign-in…")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    if (error.startsWith("auth-code:session")) {
      const link = screen.getByRole("link", { name: "Sign in another way" });
      const url = new URL(link.getAttribute("href")!, location.origin);
      expect(url.origin).toBe(location.origin);
      expect(url.pathname).toBe("/chatllm/signin");
      // Absolute: the sign-in page ignores a relative return address.
      expect(url.searchParams.get("redirectUrl")).toBe(
        `${location.origin}/bot/#/onboarding/connect`
      );
      expect(url.searchParams.get("AbacusAIBotWeb")).toBe("1");
      expect(screen.getByRole("alert").textContent).toContain(
        "session has expired"
      );
    } else {
      expect(screen.queryByText("Sign in another way")).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain(
        "contact support"
      );
      if (error.startsWith("host-complete"))
        expect(screen.getByRole("alert").textContent).toContain("UNAUTHORIZED");
    }
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("signs a new account in automatically even after another account used this browser", async () => {
  // What an earlier account's automatic sign-in left behind in this browser.
  localStorage.setItem("abacusai-bot:onboarding.autoSignIn", "started");
  vi.resetModules();
  const { startWebsiteSignIn } = await import("./first-run");
  const start = vi.fn();
  const transport = {} as Parameters<typeof startWebsiteSignIn>[0];
  await startWebsiteSignIn(transport, start);
  // A remount on the same page load does not start it again.
  await startWebsiteSignIn(transport, start);
  expect(start).toHaveBeenCalledOnce();
  localStorage.removeItem("abacusai-bot:onboarding.autoSignIn");
});

it("never shows a signed-in browser the sign-up wall: its welcome is the account connection", async () => {
  const app = await renderApp("/onboarding/welcome", { onboarded: false });
  try {
    expect(
      await screen.findByRole("heading", { name: "Connecting your account" })
    ).toBeTruthy();
    expect(screen.queryByText("Sign Up For Free")).toBeNull();
    expect(screen.queryByText("I already have an account")).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
