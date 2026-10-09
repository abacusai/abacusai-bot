/**
 * Keyboard navigation: Enter continues with the step's primary action,
 * Escape goes back where the flow allows (connect → welcome, cancelling
 * the attempt; connectors → models), and neither fires from inside a
 * control or while a dialog is open.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { primaryAction } from "./index";
import { onboardingStore } from "./store";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
});

const press = (key: string, target: Element | Document = document) =>
  act(async () => {
    fireEvent.keyDown(target, { key });
  });

describe("primaryAction", () => {
  const actions = {
    signIn: vi.fn(),
    advance: vi.fn(),
    continueConnectors: vi.fn(),
    hello: vi.fn(),
    finish: vi.fn(),
    retry: null,
  };
  it("names each step's continue", () => {
    primaryAction("welcome", actions)!();
    expect(actions.signIn).toHaveBeenCalledWith("signup");
    primaryAction("connected", actions)!();
    primaryAction("models", actions)!();
    expect(actions.advance).toHaveBeenCalledTimes(2);
    primaryAction("connectors", actions)!();
    expect(actions.continueConnectors).toHaveBeenCalled();
    primaryAction("first-bot", actions)!();
    expect(actions.hello).toHaveBeenCalled();
    primaryAction("done", actions)!();
    expect(actions.finish).toHaveBeenCalled();
    expect(primaryAction("connect", actions)).toBeNull();
    expect(primaryAction("first-bot", { ...actions, hello: null })).toBeNull();
  });
});

describe("onboarding keys", () => {
  it("Enter on welcome starts the sign-up; Escape on connect cancels back to welcome", async () => {
    let settle!: () => void;
    app = await renderApp("/onboarding/welcome", {
      onboarded: false,
      authStart: () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({ ok: false, error: "cancelled", cancelled: true });
        }),
    });
    await screen.findByRole("button", { name: "Sign up for free" });
    await press("Enter");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/connect")
    );
    expect(onboardingStore.state.signIn?.intent).toBe("signup");
    await screen.findByRole("button", { name: "Cancel" });
    await press("Escape");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/welcome")
    );
    expect(onboardingStore.state.signIn).toBeNull();
    settle();
  });

  it("Enter on models continues, Escape on connectors goes back; a focused control keeps its own Enter", async () => {
    app = await renderApp("/onboarding/models", {
      onboarded: false,
      signedIn: true,
    });
    const next = await screen.findByRole("button", { name: "Continue" });
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(false)
    );
    // Enter inside a control is the control's: the page does nothing extra.
    await press("Enter", screen.getByRole("button", { name: "Paste a key" }));
    expect(app.router.state.location.pathname).toBe("/onboarding/models");
    await press("Enter");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/connectors")
    );
    await screen.findByRole("heading", {
      name: /Chat where you work/,
    });
    await press("Escape");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/models")
    );
    await press("ArrowRight");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/connectors")
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/models")
    );
    await press("ArrowRight");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/connectors")
    );
    await press("ArrowLeft");
    await waitFor(() =>
      expect(app!.router.state.location.pathname).toBe("/onboarding/models")
    );
  });
});
