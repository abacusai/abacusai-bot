import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { onboardingStore } from "#next/features/onboarding";
import { firstBotStore } from "#next/features/onboarding/first-bot";
import {
  renderApp,
  defaultSeed,
  type AppHarness,
} from "#next/test-support/app-harness";
let harness: (AppHarness & { view: { unmount(): void } }) | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
beforeEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  firstBotStore.setState(() => ({ state: "idle" }));
});
it("R6-T2 fresh account reaches onboarding before shell; signed-out onboarded account reaches shell", async () => {
  harness = await renderApp("/bots/new", { onboarded: false });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  await harness.cleanup();
  harness = await renderApp("/bots/new", { onboarded: true });
  expect(await screen.findByRole("textbox", { name: "Name" })).toBeTruthy();
});
it("R6-T7 real router preserves failed attempts and ignores cancellation's late success", async () => {
  let outcome!: (value: { ok: false; error: string } | { ok: true }) => void;
  harness = await renderApp("/onboarding/welcome", {
    onboarded: false,
    authStart: () =>
      new Promise((resolve) => {
        outcome = resolve;
      }),
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign Up For Free" })
  );
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/connect")
  );
  await act(async () => {
    outcome({ ok: false, error: "auth-failed" });
  });
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  await act(async () => {
    await harness!.router.invalidate();
  });
  expect(harness.router.state.location.pathname).toBe("/onboarding/connect");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      harness!.calls.filter(([name]) => name === "auth.abacus.start")
    ).toHaveLength(2)
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  await act(async () => {
    outcome({ ok: true });
  });
  expect(harness.router.state.location.pathname).toBe("/onboarding/welcome");
});

it("R6-T8 no-model path persists one weekday bot and completes into the shell", async () => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  harness = await renderApp("/onboarding/welcome", { onboarded: false, seed });
  fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/models")
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe(
      "/onboarding/connectors"
    )
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Say hello" }, { timeout: 5000 })
  );
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/done")
  );
  expect(harness.collections.bots.toArray).toHaveLength(1);
  expect(harness.collections.routines.toArray).toHaveLength(1);
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/sessions/new")
  );
  expect(harness.collections.prefs.get("app")).toMatchObject({
    onboardingStep: null,
    onboardingExit: null,
  });
  expect(
    harness.calls.filter(([name]) => name === "account.skipOnboarding")
  ).toHaveLength(1);
  expect(
    harness.calls.filter(
      ([name, input]) =>
        name === "system.funnelStep" &&
        (input as { step: string }).step === "onboarding_done"
    )
  ).toEqual([["system.funnelStep", { step: "onboarding_done", once: true }]]);
});
