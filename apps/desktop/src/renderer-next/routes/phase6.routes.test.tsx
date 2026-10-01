import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { onboardingStore } from "#next/features/onboarding";
import { firstBotStore } from "#next/features/onboarding/first-bot";
import { renderApp, type AppHarness } from "#next/test-support/app-harness";
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
