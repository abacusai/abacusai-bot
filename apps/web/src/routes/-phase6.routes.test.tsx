import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { onboardingStore } from "#renderer/features/onboarding";
import { firstBotStore } from "#renderer/features/onboarding/first-bot";
import {
  renderApp,
  defaultSeed,
  type AppHarness,
} from "#renderer/test-support/app-harness";
let harness: (AppHarness & { view: { unmount(): void } }) | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
beforeEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  firstBotStore.setState(() => ({ state: "idle" }));
});
it("R6-T2 fresh account reaches onboarding before shell; signed-out onboarded account returns to the sign-in wall", async () => {
  harness = await renderApp("/bots/new", { onboarded: false });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  harness.view.unmount();
  await harness.cleanup();
  harness = await renderApp("/bots/new", { onboarded: true, signedIn: false });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/onboarding/welcome")
  );
  expect(
    await screen.findByRole("button", { name: "Sign Up For Free" })
  ).toBeTruthy();
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

it.each([false, true])(
  "R6-T8 authenticated completion creates one sponsored Chief of Staff after onboarding, channel lane=%s",
  async (hasChannelLane) => {
    const seed = defaultSeed();
    seed.bots = hasChannelLane
      ? [{ ...seed.bots![0]!, channel: "telegram" }]
      : [];
    seed.routines = [];
    harness = await renderApp("/onboarding/models", {
      onboarded: false,
      signedIn: true,
      seed,
    });
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/onboarding/models")
    );
    const continueModels = await screen.findByRole("button", {
      name: "Continue",
    });
    await waitFor(() =>
      expect((continueModels as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(continueModels);
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/onboarding/connectors"
      )
    );
    await screen.findByRole("heading", {
      name: "Connect your tools and services",
    });
    const continueConnectors = await screen.findByRole("button", {
      name: "Continue",
    });
    await waitFor(() =>
      expect((continueConnectors as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(continueConnectors);
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toMatch(/^\/bots\/bot-/)
    );
    const ownBots = harness.collections.bots.toArray.filter(
      (bot) => bot.channel == null
    );
    expect(ownBots).toHaveLength(1);
    expect(ownBots[0]).toMatchObject({
      sponsoredFirstRun: true,
    });
    expect(harness.collections.routines.toArray).toHaveLength(0);
    expect(ownBots[0]!.description).toContain("create_draft_reply");
    // Completion clears the exit only after the destination navigation settles.
    await waitFor(() =>
      expect(harness!.collections.prefs.get("app")).toMatchObject({
        onboardingStep: null,
        onboardingExit: null,
      })
    );
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
  },
  15000
);
it("the shell gate reads settings once, skips hover preloads and rereads after a credential change", async () => {
  harness = await renderApp("/bots/new");
  const reads = () =>
    harness!.calls.filter(([name]) => name === "settings.get").length;
  const first = reads();
  expect(first).toBeGreaterThan(0);
  for (const href of ["/sessions/new", "/routines", "/library/connectors"])
    await act(() => harness!.router.preloadRoute({ to: href as never }));
  await act(() => harness!.router.navigate({ to: "/routines" }));
  await act(() => harness!.router.navigate({ to: "/bots/new" }));
  expect(reads()).toBe(first);
  const { queryClient, transport } = harness.router.options.context;
  await act(() =>
    queryClient.invalidateQueries({
      queryKey: transport.orpc.settings.get.key(),
    })
  );
  await act(() => harness!.router.navigate({ to: "/routines" }));
  expect(reads()).toBeGreaterThan(first);
});
