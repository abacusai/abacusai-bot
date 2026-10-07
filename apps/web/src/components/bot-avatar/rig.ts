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
  mouthPath,
  personalityFor,
  sampleExpression,
  type Expression,
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
  ref: React.RefObject<HTMLSpanElement | null>
) => {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const seed = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 0.173;
  const [rig] = useState(() => {
    const pose = expressionFor(mood);
    return Object.fromEntries(
      channels.map((key) => [key, motionValue(pose[key])])
    ) as Rig;
  });
  const pointer = useRef({ x: 0, y: 0 });
  const pointerBounds = useRef<DOMRect | null>(null);
  useEffect(
    () => (ref.current ? observeAvatar(ref.current, setVisible) : undefined),
    [ref]
  );
  const active = animated && visible && size > 24;
  useEffect(() => {
    const controls = new Map<keyof Expression, ReturnType<typeof animate>>();
    const personality = personalityFor(shape);
    let anticipationUntil = performance.now() / 1000 + 0.1;
    let following = 0;
    let blinkUntil = 0;
    const restingEyes = expressionFor(mood).eyes;
    const update = (seconds: number, documentVisible: boolean) => {
      const moving = active && documentVisible;
      const pose = moving
        ? sampleExpression(mood, shape, seconds, seed)
        : expressionFor(mood);
      if (moving) {
        pose.gazeX += pointer.current.x;
        pose.gazeY += pointer.current.y;
        // Gaze reaches its target first. The heavier head follows on an arc.
        following += (pose.gazeX - following) * 0.12;
        pose.lean += following * 0.45;
        pose.overlap = -pose.lean * 0.6;
        if (
          seconds < anticipationUntil &&
          ["done", "excited", "surprised"].includes(mood)
        ) {
          pose.stretch = 0.96;
          pose.lift = 1;
        }
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
              mass:
                key === "gazeX" ||
                key === "gazeY" ||
                (key === "eyes" && seconds < blinkUntil)
                  ? 0.35
                  : key === "overlap"
                    ? personality.weight * 1.4
                    : personality.weight,
              stiffness:
                key === "eyes" && seconds < blinkUntil
                  ? 700
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
  }, [active, mood, shape, seed, rig]);
  const body = useTransform(() => {
    const stretch = rig.stretch.get();
    return `translateY(${rig.lift.get()}%) rotate(${rig.lean.get()}deg) scale(${0.98 / stretch}, ${0.98 * stretch})`;
  });
  const face = useTransform(
    () => `translate(${rig.gazeX.get() * 0.25}px, ${rig.gazeY.get() * 0.2}px)`
  );
  const secondary = useTransform(() => `rotate(${rig.overlap.get()}deg)`);
  const mouth = useTransform(() => mouthPath(read(rig), size <= 24 ? 1.1 : 1));
  const cheek = useTransform(() => rig.cheek.get());
  return {
    rig,
    body,
    face,
    secondary,
    mouth,
    cheek,
    active,
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
      pointer.current = { x: 0, y: 0 };
      pointerBounds.current = null;
    },
  };
};
