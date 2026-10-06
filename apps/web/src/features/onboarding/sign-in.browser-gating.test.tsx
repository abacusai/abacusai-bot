import { act, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

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
