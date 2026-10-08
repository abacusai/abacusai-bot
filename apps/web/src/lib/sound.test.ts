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
      createWaveShaper: () => ({ connect: vi.fn() }),
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

it("previews bypass gates and arbitration while attention cues retain dedupe claims", async () => {
  let enabled = false;
  const claim = vi.fn(async () => true);
  const onUnlocked = vi.fn();
  const { ctx, synth, advance } = context({
    prefs: () => ({ enabled, perEvent: {} }),
    claim,
    onUnlocked,
    createAudioContext: () => ({
      state: "running",
      resume: async () => undefined,
      close: async () => undefined,
    }),
  });
  const player = createSoundPlayer(ctx);
  player.preview("done");
  expect(player.unlocked()).toBe(true);
  await Promise.resolve();
  expect(onUnlocked).toHaveBeenCalledOnce();
  expect(claim).not.toHaveBeenCalled();
  expect(synth).toHaveBeenCalledExactlyOnceWith("done");
  enabled = true;
  advance(COALESCE_MS);
  player.play("done", { threadId: "t", dedupeKey: "run-1" });
  await Promise.resolve();
  expect(claim).toHaveBeenCalledExactlyOnceWith("done:run-1", "t");
  expect(synth).toHaveBeenCalledTimes(2);
  player.dispose();
});

it("keeps interaction tones subtle and cancels scheduled nodes immediately", () => {
  const stops: ReturnType<typeof vi.fn>[] = [];
  const disconnects: ReturnType<typeof vi.fn>[] = [];
  const levels: number[] = [];
  const audio = {
    state: "running",
    currentTime: 0,
    destination: {},
    close: async () => {},
    createWaveShaper: () => ({ connect: vi.fn() }),
    createOscillator: () => {
      const stop = vi.fn();
      stops.push(stop);
      return {
        type: "sine",
        frequency: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop,
      };
    },
    createGain: () => {
      const disconnect = vi.fn();
      disconnects.push(disconnect);
      return {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: (level: number) => levels.push(level),
        },
        connect: vi.fn(),
        disconnect,
      };
    },
  };
  const player = createSoundPlayer({
    isThreadVisible: () => false,
    isWindowFocused: () => true,
    prefs: () => ({ enabled: true, perEvent: {} }),
    now: () => 1000,
    createAudioContext: () => audio,
  });
  player.interaction("celebrate");
  expect(stops).toHaveLength(0);
  player.unlock();
  player.interaction("celebrate");
  expect(stops).toHaveLength(3);
  expect(Math.max(...levels)).toBeLessThanOrEqual(0.04);
  player.muteInteractions();
  expect(stops.every((stop) => stop.mock.calls.length === 2)).toBe(true);
  expect(
    disconnects
      .slice(0, 1)
      .concat(disconnects.slice(2))
      .every((disconnect) => disconnect.mock.calls.length === 1)
  ).toBe(true);
  player.dispose();
});
it("respects quiet hours and background focus for interaction tones", () => {
  for (const overrides of [
    { isWindowFocused: () => false },
    {
      prefs: () => ({
        enabled: true,
        perEvent: {},
        quietHours: { enabled: true, start: "22:00", end: "07:00" },
      }),
      date: () => new Date(2026, 9, 8, 23),
    },
  ]) {
    const { ctx, synth } = context(overrides);
    const player = createSoundPlayer(ctx);
    player.unlock();
    player.interaction("pop");
    expect(synth).not.toHaveBeenCalled();
    player.dispose();
  }
});
