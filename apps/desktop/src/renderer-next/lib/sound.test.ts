/** R1-T13: sound gating, coalescing, per-event and master switches. */
import { describe, expect, it, vi } from "vitest";

import { COALESCE_MS, createSoundPlayer, type SoundContext } from "./sound";

const context = (overrides: Partial<SoundContext> = {}) => {
  let now = 1_000;
  const synth = vi.fn();
  const ctx: SoundContext = {
    isThreadVisible: () => false,
    isWindowFocused: () => true,
    prefs: () => ({ enabled: true, perEvent: {} }),
    now: () => now,
    synth,
    createAudioContext: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
    ...overrides,
  };
  return { ctx, synth, advance: (ms: number) => (now += ms) };
};

describe("createSoundPlayer", () => {
  it("plays a cue", () => {
    const { ctx, synth } = context();
    createSoundPlayer(ctx).play("done");
    expect(synth).toHaveBeenCalledWith("done");
  });

  it("stays silent when the causing thread is visible and the window focused", () => {
    const { ctx, synth } = context({ isThreadVisible: () => true });
    const player = createSoundPlayer(ctx);
    player.play("received", { threadId: "t1" });
    expect(synth).not.toHaveBeenCalled();
  });

  it("plays for a visible thread when the window is not focused", () => {
    const { ctx, synth } = context({
      isThreadVisible: () => true,
      isWindowFocused: () => false,
    });
    createSoundPlayer(ctx).play("received", { threadId: "t1" });
    expect(synth).toHaveBeenCalledOnce();
  });

  it("coalesces a burst into one cue", () => {
    const { ctx, synth, advance } = context();
    const player = createSoundPlayer(ctx);
    player.play("received");
    advance(COALESCE_MS - 1);
    player.play("done");
    expect(synth).toHaveBeenCalledOnce();
    advance(COALESCE_MS);
    player.play("done");
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it("honours per-event switches and the master switch", () => {
    const perEvent = context({
      prefs: () => ({ enabled: true, perEvent: { failed: false } }),
    });
    createSoundPlayer(perEvent.ctx).play("failed");
    expect(perEvent.synth).not.toHaveBeenCalled();
    const off = context({ prefs: () => ({ enabled: false, perEvent: {} }) });
    createSoundPlayer(off.ctx).play("done");
    expect(off.synth).not.toHaveBeenCalled();
  });

  it("creates one audio context on unlock and closes it on dispose", () => {
    const { ctx } = context();
    const player = createSoundPlayer(ctx);
    player.unlock();
    player.unlock();
    expect(ctx.createAudioContext).toHaveBeenCalledOnce();
    player.dispose();
    player.play("done");
  });
});

it("R5-T26 all native players and previews use one engine, with two audible routine-fired tones", () => {
  const frequencies: number[] = [];
  const start = vi.fn();
  const close = vi.fn(async () => undefined);
  const engine = vi.fn(function () {
    return {
      currentTime: 0,
      destination: {},
      resume: async () => undefined,
      close,
      createOscillator: () => ({
        frequency: {
          setValueAtTime: (frequency: number) => frequencies.push(frequency),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start,
        stop: vi.fn(),
      }),
      createGain: () => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }),
    };
  });
  vi.stubGlobal("AudioContext", engine);
  const ctx: SoundContext = {
    isThreadVisible: () => false,
    isWindowFocused: () => false,
    prefs: () => ({
      enabled: false,
      perEvent: { "routine-fired": false },
      quietHours: { enabled: true, start: "00:00", end: "23:59" },
    }),
    now: () => 1000,
  };
  const a = createSoundPlayer(ctx);
  const b = createSoundPlayer(ctx);
  try {
    a.unlock();
    b.unlock();
    expect(engine).toHaveBeenCalledTimes(1);
    a.play("routine-fired");
    expect(start).not.toHaveBeenCalled();
    b.preview("routine-fired");
    expect(frequencies).toEqual([587, 784]);
    expect(start).toHaveBeenCalledTimes(2);
    a.dispose();
    expect(close).not.toHaveBeenCalled();
    b.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    a.dispose();
    b.dispose();
    vi.unstubAllGlobals();
  }
});
