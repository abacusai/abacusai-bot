import { createContext, useContext, useEffect } from "react";

import type { AvatarMood } from "#renderer/lib/bots/avatar";

import { identityNoise, type AvatarPersonality } from "./personality";

/** Only the dev gallery supplies overrides; production always uses the retained effects. */
export const AvatarExperimentContext = createContext<
  | Partial<{
      individuality: boolean;
      gaze: boolean;
      coupling: boolean;
      speech: boolean;
      phase: boolean;
      shading: boolean;
    }>
  | undefined
>(undefined);
export const useAvatarExperiments = () => useContext(AvatarExperimentContext);
export const SCHEDULE_SECONDS = 83;
const ease = "cubic-bezier(0.23, 1, 0.32, 1)";
type Frame = Keyframe & { offset: number };
const frame = (time: number, transform: string, opacity?: number): Frame => ({
  offset: time / SCHEDULE_SECONDS,
  transform,
  ...(opacity === undefined ? {} : { opacity }),
});

/** Fast closure, slower reopening and long irregular holds, precomputed once per lease. */
export const blinkSchedule = (id: string, p: AvatarPersonality): Frame[] => {
  const frames = [frame(0, "scaleY(1)")];
  let t = 1.2 + identityNoise(id, 200) * p.blinkGap;
  for (let i = 0; t < SCHEDULE_SECONDS - 1; i++) {
    const blink = (start: number) => {
      frames.push(
        frame(start, "scaleY(1)"),
        frame(start + p.blinkDuration * 0.35, "scaleY(.025)"),
        frame(start + p.blinkDuration, "scaleY(1)")
      );
    };
    blink(t);
    if (identityNoise(id, 201 + i) < p.doubleBlink)
      blink(t + p.blinkDuration + 0.16);
    t += p.blinkGap * (0.65 + identityNoise(id, 401 + i) * 0.9);
  }
  frames.push(frame(SCHEDULE_SECONDS, "scaleY(1)"));
  return frames;
};

export const gazeSchedule = (id: string, p: AvatarPersonality) => {
  const gaze: Frame[] = [frame(0, "translate(0px, 0px)")];
  let t = 0.8 + identityNoise(id, 601) * 2;
  let gx = 0,
    gy = 0;
  for (let i = 0; t < SCHEDULE_SECONDS - 2; i++) {
    const x =
      (identityNoise(id, 610 + i) - 0.5) * 2 * p.saccadeAmplitude + p.gazeX;
    const y = (identityNoise(id, 710 + i) - 0.5) * p.saccadeAmplitude + p.gazeY;
    gaze.push(
      frame(t, `translate(${gx}px, ${gy}px)`),
      frame(t + 0.065, `translate(${x}px, ${y}px)`),
      frame(t + 0.7, `translate(${x}px, ${y}px)`),
      frame(t + 0.765, `translate(${x + 0.18 * p.handedness}px, ${y - 0.1}px)`)
    );
    gx = x;
    gy = y;
    t += p.saccadeGap * (0.75 + identityNoise(id, 810 + i) * 0.6);
  }
  gaze.push(
    frame(SCHEDULE_SECONDS - 0.5, `translate(${gx}px, ${gy}px)`),
    frame(SCHEDULE_SECONDS, "translate(0px, 0px)")
  );
  return { gaze };
};

/** Synthetic speech energy for text streaming. No audio/phoneme input exists in BotAvatar. */
export const speechSchedule = (
  id: string,
  p: AvatarPersonality
): Keyframe[] => {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 40; i++) {
    const pause = i === 0 || i === 40 || i % 13 >= 10;
    const energy = pause ? 0.04 : 0.15 + identityNoise(id, 900 + i) * 0.85;
    const rounded = identityNoise(id, 1000 + i) > 0.6;
    frames.push({
      offset: i / 40,
      transform: `scale(${rounded ? 0.73 : 1.03}, ${0.08 + energy}) skewX(${p.handedness * energy * 2}deg)`,
      easing: ease,
    });
  }
  frames[frames.length - 1] = { ...frames[0], offset: 1 };
  return frames;
};

export const useNaturalMotion = (
  ref: React.RefObject<HTMLSpanElement | null>,
  active: boolean,
  id: string,
  p: AvatarPersonality,
  mood: AvatarMood,
  eyes: number,
  experiments: ReturnType<typeof useAvatarExperiments>
) => {
  const gaze = experiments?.gaze ?? true;
  const speech = experiments?.speech ?? true;
  const phase = experiments?.phase ?? true;
  useEffect(() => {
    if (!active || !ref.current) return;
    const animations: Animation[] = [];
    const play = (
      selector: string,
      frames: Keyframe[],
      duration = SCHEDULE_SECONDS
    ) => {
      for (const element of ref.current!.querySelectorAll(selector)) {
        if (typeof element.animate !== "function") continue;
        const animation = element.animate(frames, {
          duration: duration * 1000,
          iterations: Infinity,
        });
        animation.currentTime = phase ? (p.phase % duration) * 1000 : 0;
        animations.push(animation);
      }
    };
    if (gaze && eyes > 0.2 && mood !== "asleep")
      play(".bav-eye-open", blinkSchedule(id, p));
    if (gaze && mood !== "asleep") {
      const schedule = gazeSchedule(id, p);
      play(".bav-gaze", schedule.gaze);
    }
    if (speech && mood === "talking")
      play(".bav-speech", speechSchedule(id, p), p.speechPeriod);
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [active, id, p, mood, eyes, ref, gaze, speech, phase]);
};
