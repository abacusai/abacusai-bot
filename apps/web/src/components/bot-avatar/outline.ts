import { animate, motionValue, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { Look } from "#renderer/lib/bots/avatar";
import { springs } from "#renderer/lib/motion";

import { CONTOURS } from "./contours";
import type { Expression } from "./expression";
import type { useFaceRig } from "./rig";

export const interpolateContour = (
  from: readonly number[],
  to: readonly number[],
  t: number
) => (t === 0 ? from : t === 1 ? to : from.map((v, i) => v + (to[i]! - v) * t));
/** The two waves overlap around the perimeter. Tilt compresses the far side. */
export const outlinePath = (
  points: readonly number[],
  pose: Pick<Expression, "waveX" | "waveY" | "tiltX" | "tiltY">
): string => {
  const vertices: string[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const theta = Math.atan2(y - 50, x - 50);
    const wave =
      Math.sin(theta * 3 + 0.4) * pose.waveX +
      Math.cos(theta * 2 - 0.7) * pose.waveY;
    const far = Math.max(0, (-(x - 50) * pose.tiltX) / 50);
    const px = x + Math.cos(theta) * wave - (x - 50) * far * 0.004;
    const py =
      y + Math.sin(theta) * wave - (y - 50) * Math.abs(pose.tiltY) * 0.004;
    vertices.push(
      `${i === 0 ? "M" : "L"}${Math.max(2, Math.min(98, px)).toFixed(2)} ${Math.max(2, Math.min(98, py)).toFixed(2)}`
    );
  }
  return vertices.join(" ") + " Z";
};

/** One spring interpolates a whole outline, including interrupted look edits. */
export const useOutline = (
  look: Look,
  rig: ReturnType<typeof useFaceRig>["rig"],
  active: boolean
) => {
  const geometry = useRef({
    from: CONTOURS[look.shape],
    to: CONTOURS[look.shape],
    shape: look.shape,
  });
  const [state] = useState(() => ({
    progress: motionValue(1),
    color: motionValue(look.color),
    faceY: motionValue(
      ["bunny", "cat", "bear"].includes(look.shape)
        ? 9
        : look.shape === "heart"
          ? -3
          : 0
    ),
  }));
  useEffect(() => {
    let morph: ReturnType<typeof animate> | undefined;
    if (geometry.current.shape !== look.shape) {
      geometry.current.from = interpolateContour(
        geometry.current.from,
        geometry.current.to,
        state.progress.get()
      );
      geometry.current.to = CONTOURS[look.shape];
      geometry.current.shape = look.shape;
      state.progress.jump(active ? 0 : 1);
      if (active)
        morph = animate(state.progress, 1, {
          ...springs.character,
          stiffness: 180,
          damping: 20,
        });
    } else if (!active) state.progress.jump(1);
    else if (state.progress.get() !== 1)
      morph = animate(state.progress, 1, {
        ...springs.character,
        stiffness: 180,
        damping: 20,
      });
    const targetY = ["bunny", "cat", "bear"].includes(look.shape)
      ? 9
      : look.shape === "heart"
        ? -3
        : 0;
    const color = active
      ? animate(state.color, look.color, { duration: 0.45 })
      : undefined;
    const face = active
      ? animate(state.faceY, targetY, springs.character)
      : undefined;
    if (!active) {
      state.color.jump(look.color);
      state.faceY.jump(targetY);
    }
    return () => {
      morph?.stop();
      color?.stop();
      face?.stop();
    };
  }, [look.shape, look.color, active, state]);
  const path = useTransform(() =>
    outlinePath(
      interpolateContour(
        geometry.current.from,
        geometry.current.to,
        state.progress.get()
      ),
      {
        waveX: rig.waveX.get(),
        waveY: rig.waveY.get(),
        tiltX: rig.tiltX.get(),
        tiltY: rig.tiltY.get(),
      }
    )
  );
  const facePosition = useTransform(() => `translateY(${state.faceY.get()}px)`);
  return { path, color: state.color, facePosition };
};
