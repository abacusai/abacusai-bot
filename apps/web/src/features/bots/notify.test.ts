import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { renderHook, act } from "@testing-library/react";
/** R3-T15,T23,T27: lossless terminals, ephemeral unread, gates and reaction lifetime. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { CHECK_IN_PROMPT } from "#renderer/lib/bots/check-in";
import { allowed, isQuietNow } from "#renderer/lib/notify";
import { createSoundPlayer, synthCue, CUE_TONES } from "#renderer/lib/sound";

import { react, useReaction } from "./avatar";
import { createUnreadStore } from "./data/unread-store";
import {
  handleRunFinished,
  newlyWaiting,
  type BotsWatcherDeps,
} from "./notify";
const bot = fixtureBots()[0]!;
const notice = (patch: Partial<RunFinishedNotice> = {}): RunFinishedNotice => ({
  threadId: "never-opened",
  runId: "run",
  owner: { kind: "bot", botId: bot.id, role: "forever", key: "forever" },
  routineId: null,
  at: 1,
  outcome: "success",
  hasVisibleAssistantText: true,
  ...patch,
});
const setup = (seen = false) => {
  const deps: BotsWatcherDeps = {
    bots: () => [bot],
    routines: () => [],
    seen: () => seen,
    unread: createUnreadStore(),
    play: vi.fn(),
    notifier: { notify: vi.fn() },
    labels: {
      done: (name) => ({ title: name, body: "done" }),
      needsYou: (name) => ({ title: name, body: "waiting" }),
    },
  };
  return deps;
};
afterEach(() => vi.useRealTimers());
describe("lossless bot completion", () => {
  it("marks unread without any busy table row, including during table resync", () => {
    const d = setup();
    handleRunFinished(d, notice());
    handleRunFinished(d, notice({ runId: "during-resync" }));
    expect(d.unread.has(bot.id)).toBe(true);
    expect(d.play).toHaveBeenCalledTimes(2);
    d.unread.clear(bot.id);
    expect(d.unread.has(bot.id)).toBe(false);
    expect(createUnreadStore().has(bot.id)).toBe(false);
  });
  it.each([
    ["success", true, "received"],
    ["success", false, null],
    ["error", false, "failed"],
    ["cancelled", true, null],
  ] as const)("%s spoken=%s produces %s", (outcome, spoken, cue) => {
    const d = setup();
    handleRunFinished(d, notice({ outcome, hasVisibleAssistantText: spoken }));
    expect(d.play).toHaveBeenCalledTimes(cue ? 1 : 0);
    if (cue)
      expect(d.play).toHaveBeenCalledWith(cue, {
        threadId: "never-opened",
        botId: bot.id,
        dedupeKey: "run",
      });
    expect(d.unread.has(bot.id)).toBe(outcome !== "cancelled");
  });
  it("a visible focused chat stays read", () => {
    const d = setup(true);
    handleRunFinished(d, notice());
    expect(d.unread.has(bot.id)).toBe(false);
  });
  it("joins an ownerless check-in by routineId and plays done even when silent", () => {
    const d = setup();
    d.routines = () => [
      { id: "check", botId: bot.id, prompt: CHECK_IN_PROMPT } as RoutineRow,
    ];
    handleRunFinished(
      d,
      notice({
        owner: null,
        routineId: "check",
        hasVisibleAssistantText: false,
      })
    );
    expect(d.play).toHaveBeenCalledWith("done", {
      threadId: "never-opened",
      botId: bot.id,
      dedupeKey: "run",
    });
  });
  it("waiting notices are level changes rather than every render", () => {
    const s = {
      ...fixtureSessions()[0]!,
      turn: {
        phase: "waiting_permission" as const,
        isBusy: true,
        updatedAt: "one",
      },
    };
    const first = newlyWaiting(new Map(), [s]);
    expect(first.entered).toHaveLength(1);
    expect(newlyWaiting(first.next, [s]).entered).toHaveLength(0);
    expect(
      newlyWaiting(first.next, [
        { ...s, turn: { ...s.turn, updatedAt: "two" } },
      ]).entered
    ).toHaveLength(1);
  });
});
describe("gates and face reactions", () => {
  it("quiet hours span midnight; per-bot needs-me permits only asks", () => {
    const date = new Date(2026, 1, 1, 23);
    const quietHours = { enabled: true, start: "22:00", end: "08:00" };
    expect(isQuietNow(quietHours, date)).toBe(true);
    expect(
      allowed("received", {
        botId: bot.id,
        now: date,
        sounds: { enabled: true, perEvent: {}, quietHours },
      })
    ).toBe(false);
    const ctx = {
      botId: bot.id,
      now: date,
      sounds: {
        enabled: true,
        perEvent: {},
        perBot: { [bot.id]: "needs-me" as const },
      },
    };
    expect(allowed("received", ctx)).toBe(false);
    expect(allowed("needs-you", ctx)).toBe(true);
  });
  it("visible/focused and bursts suppress synthesis", () => {
    const synth = vi.fn();
    let seen = true;
    let now = 1000;
    const player = createSoundPlayer({
      isThreadVisible: () => seen,
      isWindowFocused: () => true,
      prefs: () => ({ enabled: true, perEvent: {} }),
      now: () => now,
      synth,
    });
    player.play("received", { threadId: "x" });
    expect(synth).not.toHaveBeenCalled();
    seen = false;
    player.play("received", { threadId: "x" });
    now += 100;
    player.play("done");
    expect(synth).toHaveBeenCalledOnce();
    player.dispose();
  });
  it.each(Object.keys(CUE_TONES) as Array<keyof typeof CUE_TONES>)(
    "%s schedules oscillator and nonzero envelope",
    (cue) => {
      const gain = vi.fn();
      const start = vi.fn();
      const stop = vi.fn();
      const audio = {
        currentTime: 0,
        destination: {},
        createGain: () => ({
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: gain },
          connect: vi.fn(),
        }),
        createOscillator: () => ({
          type: "sine",
          frequency: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          start,
          stop,
        }),
      };
      synthCue(audio as never, cue);
      expect(start).toHaveBeenCalledTimes(CUE_TONES[cue].length);
      expect(stop).toHaveBeenCalledTimes(CUE_TONES[cue].length);
      expect(gain.mock.calls.some(([v]) => v > 0.01)).toBe(true);
    }
  );
  it("reactions expire after 600 ms", () => {
    vi.useFakeTimers();
    const h = renderHook(() => useReaction("face-test"));
    act(() => react("face-test", "surprised"));
    expect(h.result.current).toBe("surprised");
    act(() => vi.advanceTimersByTime(600));
    expect(h.result.current).toBe(null);
    h.unmount();
  });
});
