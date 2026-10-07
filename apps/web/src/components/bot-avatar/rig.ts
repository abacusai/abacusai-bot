import {
  animate,
  motionValue,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

import type { AvatarMood, AvatarShape } from "#renderer/lib/bots/avatar";
import { springs } from "#renderer/lib/motion";

import { observeAvatar, subscribeClock } from "./clock";
import {
  expressionFor,
  entryExpression,
  mouthPath,
  personalityFor,
  sampleExpression,
  type Expression,
  type ExpressionMix,
} from "./expression";

type Rig = { [K in keyof Expression]: MotionValue<number> };
const channels = Object.keys(expressionFor("idle")) as (keyof Expression)[];
const read = (rig: Rig): Expression =>
  Object.fromEntries(
    channels.map((key) => [key, rig[key].get()])
  ) as unknown as Expression;

export const useFaceRig = (
  mood: AvatarMood,
  shape: AvatarShape,
  animated: boolean,
  size: number,
  ref: React.RefObject<HTMLSpanElement | null>,
  expression?: ExpressionMix
) => {
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden
  );
  const id = useId();
  const seed = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 0.173;
  const [rig] = useState(() => {
    const pose = expressionFor(mood, expression);
    return Object.fromEntries(
      channels.map((key) => [key, motionValue(pose[key])])
    ) as Rig;
  });
  const previousShape = useRef(shape);
  const pointer = useRef({ x: 0, y: 0 });
  const pressed = useRef(false);
  const pressUntil = useRef(0);
  const pointerBounds = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!animated || size <= 24) return;
    return ref.current ? observeAvatar(ref.current, setVisible) : undefined;
  }, [animated, size, ref]);
  const active = animated && visible && size > 24;
  useEffect(() => {
    const changingLook = previousShape.current !== shape;
    previousShape.current = shape;
    const controls = new Map<keyof Expression, ReturnType<typeof animate>>();
    const personality = personalityFor(shape);
    let anticipationUntil = performance.now() / 1000 + 0.1;
    let following = 0;
    let blinkUntil = 0;
    const restingEyes = expressionFor(mood, expression).eyes;
    const update = (seconds: number, documentIsVisible: boolean) => {
      setDocumentVisible(documentIsVisible);
      const moving = active && documentIsVisible;
      let pose = moving
        ? sampleExpression(mood, shape, seconds, seed, expression)
        : expressionFor(mood, expression);
      if (moving) {
        pose.gazeX += pointer.current.x;
        pose.gazeY += pointer.current.y;
        // Gaze reaches its target first. The heavier head follows on an arc.
        following += (pose.gazeX - following) * 0.12;
        pose.lean += following * 0.65;
        pose.tiltX = following * 0.9;
        pose.tiltY = pose.gazeY * 0.7;
        if (pressed.current || seconds < pressUntil.current) {
          pose.stretch *= 0.9;
          pose.lift += 2;
          pose.waveY -= 1.5;
        }
        pose = entryExpression(
          pose,
          mood,
          shape,
          seconds - anticipationUntil + 0.1,
          changingLook
        );
        pose.overlap = -pose.lean * 0.6;
      }
      if (restingEyes > 0.2 && pose.eyes < restingEyes * 0.5)
        blinkUntil = seconds + 0.3;
      for (const key of channels) {
        if (!moving) {
          controls.get(key)?.stop();
          rig[key].jump(pose[key]);
        } else if (Math.abs(rig[key].get() - pose[key]) > 0.001) {
          controls.get(key)?.stop();
          controls.set(
            key,
            animate(rig[key], pose[key], {
              ...springs.character,
              delay:
                seconds < anticipationUntil
                  ? key.startsWith("mouth") || key === "smile"
                    ? 0.06
                    : key === "eyes" || key === "wink" || key === "rightEye"
                      ? 0.025
                      : 0
                  : 0,
              damping:
                key === "waveX" || key === "waveY"
                  ? 18 + personality.weight * 3
                  : springs.character.damping,
              mass:
                key === "gazeX" ||
                key === "gazeY" ||
                ((key === "eyes" || key === "wink" || key === "rightEye") &&
                  seconds < blinkUntil)
                  ? 0.35
                  : key === "overlap"
                    ? personality.weight * 1.4
                    : personality.weight,
              stiffness:
                (key === "eyes" || key === "wink" || key === "rightEye") &&
                seconds < blinkUntil
                  ? 700
                  : key === "waveX" || key === "waveY"
                    ? 150 / (personality.softness ?? 0.65)
                    : key === "overlap"
                      ? 160
                      : springs.character.stiffness,
            })
          );
        }
      }
    };
    update(performance.now() / 1000, !document.hidden);
    const unsubscribe = active ? subscribeClock(update) : undefined;
    return () => {
      anticipationUntil = 0;
      unsubscribe?.();
      for (const control of controls.values()) control.stop();
    };
  }, [active, mood, shape, seed, rig, expression]);
  const body = useTransform(() => {
    const stretch = rig.stretch.get();
    const lift = Math.max(-5, Math.min(3, rig.lift.get()));
    const margin = 0.98 - Math.max(0, -lift - 1) * 0.018;
    return `translateY(${lift}%) rotate(${rig.lean.get()}deg) skewY(${rig.tiltX.get() * 0.35}deg) scale(${margin / stretch}, ${margin * stretch})`;
  });
  const face = useTransform(
    () =>
      `translate(${rig.tiltX.get() * 0.8}px, ${rig.tiltY.get() * 0.6}px) scaleX(${1 - Math.min(0.09, Math.abs(rig.tiltX.get()) * 0.015)})`
  );
  const secondary = rig.overlap;
  const mouth = useTransform(() => mouthPath(read(rig), size <= 24 ? 1.1 : 1));
  const cheek = useTransform(() => rig.cheek.get());
  return {
    rig,
    body,
    face,
    secondary,
    mouth,
    cheek,
    active: active && documentVisible,
    shadow: useTransform(
      () =>
        `translateX(${rig.tiltX.get() * 0.5}%) scale(${1 + Math.max(0, -rig.lift.get()) * 0.045}, ${1 - Math.max(0, -rig.lift.get()) * 0.035})`
    ),
    shadowOpacity: useTransform(() =>
      Math.max(0.35, 1 + rig.lift.get() * 0.045)
    ),
    lightX: useTransform(() => `${30 - rig.tiltX.get() * 2}%`),
    lightY: useTransform(() => `${18 - rig.tiltY.get() * 2}%`),
    onPointerDown: () => {
      if (active) {
        pressed.current = true;
        pressUntil.current = performance.now() / 1000 + 0.18;
      }
    },
    onPointerUp: () => {
      pressed.current = false;
    },
    onPointerCancel: () => {
      pressed.current = false;
    },
    onPointerEnter: (event: React.PointerEvent<HTMLSpanElement>) => {
      if (active)
        pointerBounds.current = event.currentTarget.getBoundingClientRect();
    },
    onPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => {
      if (
        !active ||
        event.pointerType !== "mouse" ||
        !window.matchMedia("(hover: hover) and (pointer: fine)").matches
      )
        return;
      const bounds = pointerBounds.current;
      if (!bounds) return;
      pointer.current = {
        x: Math.max(
          -2,
          Math.min(2, ((event.clientX - bounds.left) / bounds.width) * 4 - 2)
        ),
        y: Math.max(
          -1.5,
          Math.min(
            1.5,
            ((event.clientY - bounds.top) / bounds.height) * 3 - 1.5
          )
        ),
      };
    },
    onPointerLeave: () => {
      pressed.current = false;
      pointer.current = { x: 0, y: 0 };
      pointerBounds.current = null;
    },
  };
};
