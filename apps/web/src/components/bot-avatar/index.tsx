/** A coordinated SVG character rig. Public look, mood and hatch props stay stable. */
import "./moods.css";
import { motion, useTransform } from "motion/react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import type {
  AvatarAccessory,
  AvatarMood,
  Look,
} from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import {
  hatch as hatchMotion,
  useMotionPreference,
} from "#renderer/lib/motion";

import { opticalSize } from "./expression";
import { BODIES, EARS } from "./geometry";
import { useFaceRig } from "./rig";

const ACCESSORIES: Record<
  Exclude<AvatarAccessory, "none">,
  { d: string; fill: string; stroke: string }
> = {
  glasses: {
    d: "M27 47a10 10 0 1 0 20 0a10 10 0 1 0-20 0z M53 47a10 10 0 1 0 20 0a10 10 0 1 0-20 0z M47 47h6",
    fill: "none",
    stroke: "#17171a",
  },
  shades: {
    d: "M16 40h30l-3 14H20z M54 40h30l-3 14H57z M46 42h8",
    fill: "#17171a",
    stroke: "#17171a",
  },
  bow: {
    d: "M50 12 30 2v20z M50 12l20-10v20z",
    fill: "#f472b6",
    stroke: "#e11d48",
  },
  cap: {
    d: "M22 30c0-18 56-18 56 0z M14 30h72",
    fill: "#3b82f6",
    stroke: "#1d4ed8",
  },
  headphones: {
    d: "M14 52V40a36 36 0 0 1 72 0v12 M8 50h12v18H8z M80 50h12v18H80z",
    fill: "none",
    stroke: "#17171a",
  },
  antenna: {
    d: "M50 24V12 M50 7a5 5 0 1 0 0 .1",
    fill: "#e879f9",
    stroke: "#e879f9",
  },
  crown: {
    d: "M22 26 30 2l20 14L70 2l8 24z",
    fill: "#facc15",
    stroke: "#ca8a04",
  },
  monocle: {
    d: "M53 47a10 10 0 1 0 20 0a10 10 0 1 0-20 0z M73 52l6 22",
    fill: "none",
    stroke: "#17171a",
  },
};

const SPARK = "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z";
const HEART =
  "M12 21s-7-4.6-9.3-9A5.2 5.2 0 0 1 12 6.4 5.2 5.2 0 0 1 21.3 12C19 16.4 12 21 12 21z";

const Extra = ({ mood }: { mood: AvatarMood }) => {
  switch (mood) {
    case "asleep":
      return (
        <>
          <span className="bav-x bav-zz">z</span>
          <span className="bav-x bav-zz b">z</span>
        </>
      );
    case "confused":
      return <span className="bav-x bav-q">?</span>;
    case "surprised":
      return <span className="bav-x bav-bang">!</span>;
    case "blocked":
      return <span className="bav-x bav-sweat" />;
    case "happy":
    case "done":
    case "excited":
      return (
        <svg
          className="bav-x bav-spark"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d={SPARK} />
        </svg>
      );
    case "love":
      return (
        <svg
          className="bav-x bav-heart"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d={HEART} />
        </svg>
      );
    case "focused":
      return <span className="bav-halo" />;
    default:
      return null;
  }
};

export interface BotAvatarProps {
  look: Look;
  /** Lifecycle or reaction; `done` wears the happy face (canvas). */
  mood?: AvatarMood;
  /** Rendered size in px (22 title bar, 36 sidebar, 56 transcript, 96 setup). */
  size: number;
  /** Allow character motion, subject to visibility and motion preference. */
  animate?: boolean;
  /** An accessible name; without one the avatar is decorative. */
  label?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  hatch?: { from: "egg"; onDone(): void };
}

/** Both eyes use the same lid channel, with an explicit wink multiplier. */
const Eye = ({
  x,
  rig,
  optics,
  left,
}: {
  x: number;
  rig: ReturnType<typeof useFaceRig>["rig"];
  optics: ReturnType<typeof opticalSize>;
  left: boolean;
}) => {
  const lidClip = useId();
  const opening = useTransform(() =>
    Math.max(0.025, rig.eyes.get() * (left ? rig.wink.get() : 1))
  );
  const pupil = useTransform(
    () => `translate(${rig.gazeX.get()}px, ${rig.gazeY.get()}px)`
  );
  const aperture = useTransform(() => {
    const height = optics.eyeRadius * 2.5 * opening.get();
    return `M${x - optics.eyeRadius - 4} ${47 - height / 2}h${optics.eyeRadius * 2 + 8}v${height}h${-optics.eyeRadius * 2 - 8}Z`;
  });
  const lid = useTransform(
    () =>
      `M${x - optics.eyeRadius} 47 Q${x} ${47 + rig.lidCurve.get()} ${x + optics.eyeRadius} 47`
  );
  const closed = useTransform(
    () => 1 - Math.min(1, Math.max(0, (opening.get() - 0.12) * 5))
  );
  const open = useTransform(() =>
    Math.min(1, Math.max(0, (opening.get() - 0.12) * 5))
  );
  const brow = useTransform(
    () =>
      `M${x - 6} ${34 - rig.brow.get() + ((left ? -1 : 1) * rig.browTilt.get()) / 2} Q${x} ${32 - rig.brow.get()} ${x + 6} ${34 - rig.brow.get() + ((left ? 1 : -1) * rig.browTilt.get()) / 2}`
  );
  return (
    <g className="bav-eye">
      <defs>
        <clipPath id={lidClip}>
          <motion.path d={aperture} />
        </clipPath>
      </defs>
      {optics.brows && (
        <motion.path
          d={brow}
          fill="none"
          stroke="var(--bav-ink)"
          strokeWidth={optics.line * 0.8}
          strokeLinecap="round"
          opacity={0.8}
        />
      )}
      <g clipPath={`url(#${lidClip})`}>
        <motion.g
          style={{
            transform: pupil,
            transformOrigin: `${x}px 47px`,
            opacity: open,
          }}
        >
          <ellipse
            cx={x}
            cy={47}
            rx={optics.eyeRadius}
            ry={optics.eyeRadius * 1.25}
            fill="var(--bav-ink)"
          />
          {optics.highlights && (
            <>
              <ellipse
                cx={x - 1.8}
                cy={44}
                rx={1.8}
                ry={2.2}
                fill="white"
                opacity={0.95}
              />
              <circle cx={x + 2} cy={49} r={0.8} fill="white" opacity={0.4} />
            </>
          )}
        </motion.g>
      </g>
      <motion.path
        d={lid}
        style={{ opacity: closed }}
        stroke="var(--bav-ink)"
        strokeWidth={optics.line}
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
};

const AvatarBody = ({
  look,
  mood = "idle",
  size,
  animate = false,
  label,
  title,
  className,
  style,
}: BotAvatarProps) => {
  const reduced = useMotionPreference() === "reduced";
  const gradient = useId();
  const optics = opticalSize(size);
  const rootRef = useRef<HTMLSpanElement>(null);
  const faceRig = useFaceRig(
    mood,
    look.shape,
    animate && !reduced,
    size,
    rootRef
  );
  const { rig } = faceRig;
  const ears = EARS[look.shape];
  const animal = ears != null;
  const accessory =
    look.accessory === "none" ? null : ACCESSORIES[look.accessory];
  const faceY = animal ? 9 : look.shape === "heart" ? -3 : 0;
  const tongue = useTransform(() => Math.min(1, rig.mouthOpen.get() / 5));
  return (
    <span
      ref={rootRef}
      className={cn("bav", className)}
      data-slot="bot-avatar"
      data-shape={look.shape}
      data-mood={mood}
      data-animate={faceRig.active ? "" : undefined}
      data-optical={optics.tiny ? "tiny" : "full"}
      role={label != null ? "img" : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      title={title}
      onPointerEnter={faceRig.onPointerEnter}
      onPointerMove={faceRig.onPointerMove}
      onPointerLeave={faceRig.onPointerLeave}
      style={
        {
          "--bav-size": `${size}px`,
          "--bav-color": look.color,
          ...style,
        } as CSSProperties
      }
    >
      <span className="bav-shadow" />
      <motion.span
        className="bav-character"
        style={{ transform: faceRig.body }}
      >
        <svg className="bav-svg" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id={gradient} cx="30%" cy="18%" r="90%">
              <stop offset="0" stopColor="white" stopOpacity=".5" />
              <stop offset=".48" stopColor="white" stopOpacity=".06" />
              <stop offset="1" stopColor="#172437" stopOpacity=".19" />
            </radialGradient>
            <clipPath id={`${gradient}-mouth`}>
              <motion.path d={faceRig.mouth} />
            </clipPath>
          </defs>
          {ears && (
            <motion.g
              className="bav-ears"
              style={{
                transform: faceRig.secondary,
                transformOrigin: "50px 40px",
              }}
            >
              <path d={ears} fill={look.color} />
              <path d={ears} fill={`url(#${gradient})`} />
              <path
                d={ears}
                fill="#ffadc4"
                opacity=".2"
                transform="translate(10 6) scale(.8)"
              />
            </motion.g>
          )}
          <path className="bav-body" d={BODIES[look.shape]} fill={look.color} />
          <path
            d={BODIES[look.shape]}
            fill={`url(#${gradient})`}
            stroke="white"
            strokeOpacity=".25"
            strokeWidth=".8"
          />
          <g transform={`translate(0 ${faceY})`}>
            <motion.g className="bav-face" style={{ transform: faceRig.face }}>
              {optics.cheeks && (
                <motion.g
                  className="bav-cheeks"
                  style={{ opacity: faceRig.cheek }}
                >
                  <ellipse cx="25" cy="60" rx="7" ry="3.8" fill="#f2769c" />
                  <ellipse cx="75" cy="60" rx="7" ry="3.8" fill="#f2769c" />
                </motion.g>
              )}
              <Eye x={50 - optics.eyeSpacing} rig={rig} optics={optics} left />
              <Eye
                x={50 + optics.eyeSpacing}
                rig={rig}
                optics={optics}
                left={false}
              />
              <motion.path
                className="bav-mouth"
                d={faceRig.mouth}
                fill="var(--bav-ink)"
                stroke="var(--bav-ink)"
                strokeWidth={optics.line}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {!optics.tiny && (
                <motion.ellipse
                  cx="50"
                  cy="72"
                  rx="6"
                  ry="2.5"
                  fill="#fa92ad"
                  clipPath={`url(#${gradient}-mouth)`}
                  style={{ opacity: tongue }}
                />
              )}
            </motion.g>
            {accessory &&
              ["glasses", "monocle", "shades"].includes(look.accessory) && (
                <g className="bav-acc" data-accessory={look.accessory}>
                  <path
                    d={accessory.d}
                    fill={accessory.fill}
                    stroke={accessory.stroke}
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              )}
          </g>
          {accessory &&
            !["glasses", "monocle", "shades"].includes(look.accessory) && (
              <motion.g
                className="bav-acc"
                data-accessory={look.accessory}
                style={{
                  transform: faceRig.secondary,
                  transformOrigin: "50px 30px",
                }}
              >
                <path
                  d={accessory.d}
                  fill={accessory.fill}
                  stroke={accessory.stroke}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </motion.g>
            )}
        </svg>
        {optics.particles && <Extra mood={mood} />}
      </motion.span>
    </span>
  );
};

const HatchingAvatar = ({
  hatch,
  ...props
}: BotAvatarProps & {
  hatch: NonNullable<BotAvatarProps["hatch"]>;
}) => {
  const reduced = useMotionPreference() === "reduced";
  const [egg, setEgg] = useState(true);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setEgg(false),
      reduced ? 120 : hatchMotion.wobbleCycles * hatchMotion.wobbleMs
    );
    return () => clearTimeout(timer);
  }, [reduced]);
  return (
    <motion.span
      className={egg && !reduced ? "bav-hatch-egg" : undefined}
      data-animate={!reduced ? "" : undefined}
      key={egg ? "egg" : "hatched"}
      initial={
        egg
          ? { opacity: 1, scale: 1 }
          : reduced
            ? { opacity: 0 }
            : { scale: hatchMotion.squash }
      }
      animate={{
        opacity: 1,
        scale: egg || reduced || settled ? 1 : hatchMotion.pop,
      }}
      transition={reduced ? { duration: 0.12 } : hatchMotion.settle}
      onAnimationComplete={() => {
        if (!egg) {
          if (reduced || settled) hatch.onDone();
          else setSettled(true);
        }
      }}
    >
      <AvatarBody
        {...props}
        look={egg ? { ...props.look, shape: "egg" } : props.look}
      />
    </motion.span>
  );
};
export const BotAvatar = (props: BotAvatarProps) =>
  props.hatch ? (
    <HatchingAvatar {...props} hatch={props.hatch} />
  ) : (
    <AvatarBody {...props} />
  );

/**
 * §14.5: the class that gives an accent-filled control or dot its light-theme
 * 1 px `--muted-foreground` boundary (none in dark theme).
 */
export const ACCENT_OUTLINE_CLASS = "accent-outline";
