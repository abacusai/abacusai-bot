import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  player: {
    interaction: vi.fn(),
    muteInteractions: vi.fn(),
    unlock: vi.fn(),
    dispose: vi.fn(),
  },
  reduced: false,
  sounds: { enabled: true, perEvent: {} as Record<string, boolean> },
}));
vi.mock("#renderer/data/db/prefs", async (original) => ({
  ...(await original<typeof import("#renderer/data/db/prefs")>()),
  usePrefs: () => ({ ...DEFAULT_PREFS, sounds: mocks.sounds }),
  useUpdatePrefs: () => mocks.update,
}));
vi.mock("#renderer/lib/motion", () => ({
  useMotionPreference: () => (mocks.reduced ? "reduced" : "full"),
}));
vi.mock("#renderer/lib/sound", () => ({
  createSoundPlayer: () => mocks.player,
}));
import { onboardingSoundEnabled, useOnboardingSound } from "./sound";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reduced = false;
  mocks.sounds = { enabled: true, perEvent: {} };
});
it("defaults on desktop and off in browsers, with saved preference taking precedence", () => {
  expect(onboardingSoundEnabled(DEFAULT_PREFS.sounds, true)).toBe(true);
  expect(onboardingSoundEnabled(DEFAULT_PREFS.sounds, false)).toBe(false);
  expect(
    onboardingSoundEnabled(
      { ...DEFAULT_PREFS.sounds, perEvent: { onboarding: false } },
      true
    )
  ).toBe(false);
  expect(
    onboardingSoundEnabled(
      { ...DEFAULT_PREFS.sounds, perEvent: { onboarding: true } },
      false
    )
  ).toBe(true);
});
it("persists toggles and stops active tones immediately when muted", async () => {
  mocks.sounds.perEvent.onboarding = true;
  const view = renderHook(useOnboardingSound);
  await act(async () => view.result.current.toggle());
  expect(mocks.update).toHaveBeenCalledWith({
    sounds: { perEvent: { onboarding: false } },
  });
  expect(mocks.player.muteInteractions).toHaveBeenCalled();
});
it("unlocks audio only after a gesture", async () => {
  mocks.sounds.perEvent.onboarding = false;
  const view = renderHook(useOnboardingSound);
  expect(mocks.player.unlock).not.toHaveBeenCalled();
  await act(async () => view.result.current.toggle());
  expect(mocks.player.unlock).toHaveBeenCalledOnce();
  expect(mocks.update).toHaveBeenCalledWith({
    sounds: { perEvent: { onboarding: true } },
  });
});
it("pauses tones under reduced motion and releases the player on unmount", () => {
  mocks.reduced = true;
  const view = renderHook(useOnboardingSound);
  expect(mocks.player.muteInteractions).toHaveBeenCalled();
  view.unmount();
  expect(mocks.player.dispose).toHaveBeenCalledOnce();
});
