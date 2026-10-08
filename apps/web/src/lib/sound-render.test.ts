import { expect, it } from "vitest";

import {
  chrome,
  renderSoundLevels,
} from "#renderer/test-support/offline-sound";

import { INTERACTION_TONES } from "./sound";

it.skipIf(!chrome)(
  "renders onboarding cues with native OfflineAudioContext",
  async () => {
    const { cues, overload } = await renderSoundLevels(INTERACTION_TONES, {
      pop: [{ at: 0, duration: 0.06, from: 520, to: 780, gain: 0.018 }],
      step: [
        { at: 0, duration: 0.09, from: 660, gain: 0.018 },
        { at: 0.1, duration: 0.09, from: 880, gain: 0.015 },
      ],
      celebrate: [523, 659, 784].map((from, index) => ({
        at: index * 0.08,
        duration: 0.12,
        from,
        gain: 0.015,
      })),
    });
    for (const { before, after } of Object.values(cues)) {
      expect(after.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
      expect(after.peak / before.peak).toBeGreaterThan(1.95);
      expect(after.peak / before.peak).toBeLessThan(2.05);
      expect(after.rms / before.rms).toBeGreaterThan(1.85);
      expect(after.rms / before.rms).toBeLessThan(2.1);
      expect(after.duration).toBeGreaterThan(0.04);
      expect(after.duration).toBeLessThan(0.32);
    }
    expect(overload.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
  },
  45000
);
