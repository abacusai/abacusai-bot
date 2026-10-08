import { expect, it } from "vitest";

import {
  chrome,
  renderSoundLevels,
} from "#renderer/test-support/offline-sound";

import { CUE_TONES } from "./sound";

it.skipIf(!chrome)(
  "renders chat cues with native OfflineAudioContext",
  async () => {
    const { cues, overload } = await renderSoundLevels(CUE_TONES, {
      ...CUE_TONES,
      sent: [{ at: 0, duration: 0.09, from: 660, to: 880, gain: 0.08 }],
      received: [
        { at: 0, duration: 0.07, from: 880, gain: 0.07 },
        { at: 0.11, duration: 0.07, from: 1175, gain: 0.07 },
      ],
      done: [
        { at: 0, duration: 0.09, from: 523, gain: 0.08 },
        { at: 0.12, duration: 0.09, from: 784, gain: 0.08 },
      ],
    });
    for (const { after } of Object.values(cues)) {
      expect(after.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
      expect(after.rms).toBeGreaterThan(0.001);
      expect(after.duration).toBeGreaterThan(0.04);
      expect(after.duration).toBeLessThan(0.32);
    }
    expect(cues.sent!.after.duration).toBeGreaterThan(0.12);
    expect(cues.sent!.after.duration).toBeLessThan(0.2);
    expect(cues.sent!.after.rms / cues.sent!.before.rms).toBeGreaterThan(1.4);
    for (const cue of ["done", "received"]) {
      const { before, after } = cues[cue]!;
      expect(after.peak / before.peak).toBeGreaterThan(1.7);
      expect(after.peak / before.peak).toBeLessThan(2);
      expect(after.rms / before.rms).toBeGreaterThan(1.8);
      expect(after.rms / before.rms).toBeLessThan(2.3);
    }
    expect(cues.done!.after.duration).toBeGreaterThan(0.24);
    expect(overload.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
  },
  45000
);
