/**
 * Sound cues (spec 01 §7.8; synthesis spec 03 §17, gates spec 05 §23.1).
 * One AudioContext, created lazily on `unlock()` (the first pointerdown);
 * nothing plays before it. The values are provisional and live only here.
 */
import type { PrefsRow } from "#shared/contract";

import { allowed } from "./notify";

export type Cue =
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
  /** For tests; the default synthesises into the unlocked AudioContext. */
  synth?(cue: Cue): void;
  claim?(cueId: string, threadId: string | null): Promise<boolean>;
  /** For tests (quiet hours); defaults to `new Date(now())`. */
  date?(): Date;
  /** For tests; the real one is `new AudioContext()`. */
  createAudioContext?(): unknown;
  onUnlocked?(): void;
}

export interface SoundPlayer {
  play(
    cue: Cue,
    options?: { threadId?: string; botId?: string | null; dedupeKey?: string }
  ): void;
  preview(cue: Cue): void;
  unlock(): void;
  unlocked(): boolean;
  dispose(): void;
}

/** A burst of cues inside this window plays once. */
export const COALESCE_MS = 400;

// All document players, including previews, share the native engine.
let documentAudio: AudioContext | null = null;
let audioUsers = 0;
let documentLastPlayed = Number.NEGATIVE_INFINITY;
export const createSoundPlayer = (ctx: SoundContext): SoundPlayer => {
  let lastPlayedAt = Number.NEGATIVE_INFINITY;
  let audio: unknown = null;
  let disposed = false;
  const shared =
    ctx.createAudioContext === undefined && ctx.synth === undefined;

  const synth =
    ctx.synth ??
    ((cue: Cue) => {
      if (audio != null) synthCue(audio as AudioContextLike, cue);
    });

  return {
    play(cue, options = {}) {
      if (disposed || (cue === "sent" && !ctx.isWindowFocused())) return;
      const prefs = ctx.prefs();
      if (!prefs.enabled) return;
      if (prefs.perEvent[cue] === false) return;
      if (
        !allowed(cue, {
          botId: options.botId ?? null,
          now: ctx.date?.() ?? new Date(ctx.now()),
          sounds: prefs,
        })
      )
        return;
      if (
        cue !== "sent" &&
        options.threadId !== undefined &&
        ctx.isWindowFocused() &&
        ctx.isThreadVisible(options.threadId)
      )
        return;
      const now = ctx.now();
      if (now - (shared ? documentLastPlayed : lastPlayedAt) < COALESCE_MS)
        return;
      lastPlayedAt = now;
      if (shared) documentLastPlayed = now;
      if (ctx.claim && cue !== "sent" && cue !== "routine-fired") {
        if (!audio && !ctx.synth) return;
        void ctx
          .claim(
            `${cue}:${options.dedupeKey ?? `${options.threadId ?? ""}:${now}`}`,
            options.threadId ?? null
          )
          .then((play) => {
            if (play && !disposed) synth(cue);
          })
          .catch(() => undefined);
      } else synth(cue);
    },
    preview(cue) {
      if (disposed) return;
      this.unlock();
      const resume = (audio as AudioContext | null)?.resume;
      if (resume != null) void resume.call(audio).catch(() => undefined);
      synth(cue);
    },
    unlock() {
      if (audio !== null || disposed) return;
      const create =
        ctx.createAudioContext ??
        (() =>
          typeof AudioContext === "undefined" ? null : new AudioContext());
      try {
        if (shared) {
          documentAudio ??= create() as AudioContext | null;
          audio = documentAudio;
          if (audio) audioUsers++;
        } else audio = create();
        const context = audio as { resume?: () => Promise<void> } | null;
        void Promise.resolve(context?.resume?.())
          .then(() => {
            if (
              !disposed &&
              (audio as { state?: string } | null)?.state === "running"
            )
              ctx.onUnlocked?.();
          })
          .catch(() => undefined);
      } catch {
        audio = null;
      }
    },
    unlocked() {
      return (
        audio != null &&
        ((audio as { state?: string }).state == null ||
          (audio as { state?: string }).state === "running")
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (shared && audio) {
        audioUsers--;
        if (audioUsers > 0) {
          audio = null;
          return;
        }
        documentAudio = null;
        documentLastPlayed = Number.NEGATIVE_INFINITY;
      }
      const close = (audio as { close?: () => Promise<void> } | null)?.close;
      if (close != null) void close.call(audio).catch(() => undefined);
      audio = null;
    },
  };
};

/** What synthesis needs of an (Offline)AudioContext. */
export type AudioContextLike = Pick<
  BaseAudioContext,
  "currentTime" | "destination" | "createOscillator" | "createGain"
>;

interface Tone {
  /** Seconds after the cue starts. */
  at: number;
  duration: number;
  from: number;
  to?: number;
  gain: number;
  type?: OscillatorType;
}

/** 03 §17 (and 05 §23.1 for `routine-fired`); `done` is provisional (06 §14.1). */
export const CUE_TONES: Readonly<Record<Cue, readonly Tone[]>> = {
  sent: [{ at: 0, duration: 0.09, from: 660, to: 880, gain: 0.08 }],
  received: [
    { at: 0, duration: 0.07, from: 880, gain: 0.07 },
    { at: 0.11, duration: 0.07, from: 1175, gain: 0.07 },
  ],
  "needs-you": [0, 0.08, 0.16].map((at) => ({
    at,
    duration: 0.06,
    from: 740,
    gain: 0.09,
    type: "triangle" as const,
  })),
  done: [
    { at: 0, duration: 0.09, from: 523, gain: 0.08 },
    { at: 0.12, duration: 0.09, from: 784, gain: 0.08 },
  ],
  failed: [{ at: 0, duration: 0.18, from: 440, to: 294, gain: 0.08 }],
  "routine-fired": [
    { at: 0, duration: 0.05, from: 587, gain: 0.06 },
    { at: 0.11, duration: 0.05, from: 784, gain: 0.06 },
  ],
};

/** Schedules one cue's tones: sine by default, exponential release. */
export const synthCue = (
  audio: AudioContextLike,
  cue: Cue,
  start: number = audio.currentTime
): void => {
  for (const tone of CUE_TONES[cue]) {
    const t0 = start + tone.at;
    const t1 = t0 + tone.duration;
    const oscillator = audio.createOscillator();
    oscillator.type = tone.type ?? "sine";
    oscillator.frequency.setValueAtTime(tone.from, t0);
    if (tone.to != null)
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, t1);
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, t0);
    envelope.gain.exponentialRampToValueAtTime(tone.gain, t0 + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t1);
    oscillator.connect(envelope);
    envelope.connect(audio.destination);
    oscillator.start(t0);
    oscillator.stop(t1 + 0.02);
  }
};

/** Settings preview is local and never claims an attention cue. */
/** @public Phase-5 Settings preview; intentionally bypasses cross-window arbitration. */
export const previewCue = (audio: AudioContextLike, cue: Cue): void =>
  synthCue(audio, cue);
