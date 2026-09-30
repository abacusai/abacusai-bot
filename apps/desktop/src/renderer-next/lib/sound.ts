/**
 * Sound cues (spec 01 §7.8). No audio in phase 1: the gating rules are real
 * and tested; `synth` is a no-op until phase 3 fills it. One AudioContext,
 * created lazily on `unlock()` (the first pointerdown).
 */
import type { PrefsRow } from "#shared/contract";

type Cue =
  | "sent"
  | "received"
  | "needs-you"
  | "done"
  | "failed"
  | "routine-fired";

export interface SoundContext {
  isThreadVisible(threadId: string): boolean;
  isWindowFocused(): boolean;
  prefs(): PrefsRow["sounds"];
  now(): number;
  /** For tests; phase 3 synthesises here. */
  synth?(cue: Cue): void;
  /** For tests; the real one is `new AudioContext()`. */
  createAudioContext?(): unknown;
}

export interface SoundPlayer {
  play(cue: Cue, options?: { threadId?: string }): void;
  unlock(): void;
  dispose(): void;
}

/** A burst of cues inside this window plays once. */
export const COALESCE_MS = 400;

export const createSoundPlayer = (ctx: SoundContext): SoundPlayer => {
  let lastPlayedAt = Number.NEGATIVE_INFINITY;
  let audio: unknown = null;
  let disposed = false;

  const synth = ctx.synth ?? ((_cue: Cue) => undefined);

  return {
    play(cue, options = {}) {
      if (disposed) return;
      const prefs = ctx.prefs();
      if (!prefs.enabled) return;
      if (prefs.perEvent[cue] === false) return;
      if (
        options.threadId !== undefined &&
        ctx.isWindowFocused() &&
        ctx.isThreadVisible(options.threadId)
      )
        return;
      const now = ctx.now();
      if (now - lastPlayedAt < COALESCE_MS) return;
      lastPlayedAt = now;
      synth(cue);
    },
    unlock() {
      if (audio !== null || disposed) return;
      const create =
        ctx.createAudioContext ??
        (() =>
          typeof AudioContext === "undefined" ? null : new AudioContext());
      audio = create();
    },
    dispose() {
      disposed = true;
      const close = (audio as { close?: () => Promise<void> } | null)?.close;
      if (close != null) void close.call(audio).catch(() => undefined);
      audio = null;
    },
  };
};
