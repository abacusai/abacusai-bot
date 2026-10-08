import {
  animate,
  motionValue,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { AvatarMood, AvatarShape } from "#renderer/lib/bots/avatar";
import { springs } from "#renderer/lib/motion";

import {
  claimAnimation,
  observeAvatar,
  subscribeActivity,
  subscribeClock,
  subscribePointer,
} from "./clock";
import {
  expressionFor,
  individualExpression,
  entryExpression,
  mouthPath,
  personalityFor,
  sampleExpression,
  type Expression,
  type ExpressionMix,
} from "./expression";
import type { AvatarPersonality } from "./personality";

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
  expression?: ExpressionMix,
  interactive = true,
  individual?: AvatarPersonality,
  coupled = true,
  followPointer = true
) => {
  const [admitted, setAdmitted] = useState(false);
  const [interaction, setInteraction] = useState(false);
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden
  );
  const seed = individual?.phase ?? 0;
  const [rig] = useState(() => {
    const base = expressionFor(mood, expression);
    const pose =
      individual && coupled ? individualExpression(base, individual) : base;
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
  const priority = interaction
    ? 3
    : mood === "talking" || mood === "listening"
      ? 2
      : mood === "idle" || mood === "asleep"
        ? 0
        : 1;
  useEffect(
    () =>
      animated && visible && size > 24
        ? claimAnimation(setAdmitted, priority)
        : undefined,
    [animated, visible, size, priority]
  );
  const active = animated && visible && admitted && size > 24;
  useEffect(
    () => (active ? subscribeActivity(setDocumentVisible) : undefined),
    [active]
  );
  const dynamic = interaction;
  useEffect(() => {
    const changingLook = previousShape.current !== shape;
    previousShape.current = shape;
    const controls = new Map<keyof Expression, ReturnType<typeof animate>>();
    const personality = personalityFor(shape);
    let anticipationUntil =
      performance.now() / 1000 + 0.1 + (individual?.latency ?? 0);
    let following = 0;
    let blinkUntil = 0;
    const restingEyes = expressionFor(mood, expression).eyes;
    const update = (seconds: number, documentIsVisible: boolean) => {
      const moving = active && documentIsVisible;
      let pose =
        moving && dynamic
          ? sampleExpression(mood, shape, seconds, seed, expression)
          : expressionFor(mood, expression);
      if (individual && coupled) pose = individualExpression(pose, individual);
      if (moving) {
        pose.gazeX += pointer.current.x;
        pose.gazeY += pointer.current.y;
        // Gaze reaches its target first. The heavier head follows on an arc.
        following += (pose.gazeX - following) * 0.12;
        pose.lean += following * 0.65;

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
                      : springs.character.stiffness *
                        (individual?.stiffness ?? 1),
            })
          );
        }
      }
    };
    update(performance.now() / 1000, documentVisible);
    let unsubscribe =
      active && documentVisible ? subscribeClock(update) : undefined;
    // Resting bodies breathe on the compositor. JS only blends entry/return poses.
    const settle =
      active && documentVisible && !dynamic
        ? setTimeout(() => {
            unsubscribe?.();
            unsubscribe = undefined;
          }, 1000)
        : undefined;
    return () => {
      anticipationUntil = 0;
      clearTimeout(settle);
      unsubscribe?.();
      for (const control of controls.values()) control.stop();
    };
  }, [
    active,
    documentVisible,
    dynamic,
    mood,
    shape,
    seed,
    rig,
    expression,
    individual,
    coupled,
  ]);
  useEffect(() => {
    if (
      !active ||
      !documentVisible ||
      !interactive ||
      !followPointer ||
      !ref.current?.closest("[data-avatar-scene]") ||
      !matchMedia("(hover: hover) and (pointer: fine)").matches
    )
      return;
    return subscribePointer((position) => {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      pointer.current = {
        x: Math.max(
          -3,
          Math.min(3, (position.x - bounds.x - bounds.width / 2) / 70)
        ),
        y: Math.max(
          -2,
          Math.min(2, (position.y - bounds.y - bounds.height / 2) / 70)
        ),
      };
      rig.gazeX.set(pointer.current.x);
      rig.gazeY.set(pointer.current.y);
      rig.lean.set(rig.lean.get() * 0.8 + pointer.current.x * 0.13);
    });
  }, [active, documentVisible, interactive, followPointer, ref, rig]);
  const body = useTransform(() => {
    const stretch = rig.stretch.get();
    const lift = Math.max(-5, Math.min(3, rig.lift.get()));
    const margin = 0.98 - Math.max(0, -lift - 1) * 0.018;
    return `translateY(${lift}%) rotate(${rig.lean.get()}deg) scale(${margin / stretch}, ${margin * stretch})`;
  });
  const face = useTransform(
    () => `translate(${rig.tiltX.get() * 0.8}px, ${rig.tiltY.get() * 0.6}px)`
  );
  const secondary = rig.overlap;
  const mouth = useTransform(() => mouthPath(read(rig), size <= 24 ? 1.1 : 1));
  const cheek = useTransform(() => rig.cheek.get());
  return {
    rig,
    body,
    face,
    deform: useTransform(
      () =>
        `skewX(${rig.waveX.get() * 0.8}deg) scale(${1 + rig.waveY.get() * 0.008}, ${1 / (1 + rig.waveY.get() * 0.008)})`
    ),
    steady: active && documentVisible,
    seed,
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
      if (interactive && animated && visible && size > 24) {
        setInteraction(true);
        pressed.current = true;
        pressUntil.current = performance.now() / 1000 + 0.18;
      }
    },
    onPointerUp: () => {
      setInteraction(false);
      pressed.current = false;
    },
    onPointerCancel: () => {
      setInteraction(false);
      pressed.current = false;
    },
    onPointerEnter: (event: React.PointerEvent<HTMLSpanElement>) => {
      if (
        interactive &&
        animated &&
        visible &&
        size > 24 &&
        event.pointerType === "mouse" &&
        window.matchMedia("(hover: hover) and (pointer: fine)").matches
      ) {
        setInteraction(true);
        pointerBounds.current = event.currentTarget.getBoundingClientRect();
      }
    },
    onPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => {
      if (
        !interactive ||
        !animated ||
        !visible ||
        size <= 24 ||
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
      setInteraction(false);
      pressed.current = false;
      pointer.current = { x: 0, y: 0 };
      pointerBounds.current = null;
    },
  };
};
