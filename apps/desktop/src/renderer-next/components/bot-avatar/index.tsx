/**
 * BotAvatar (spec 03 §14, canvas BotAvatar/Avatars): a body (CSS radii for
 * the soft shapes, an SVG path for the drawn ones, ears for bunny/cat/bear),
 * a face per mood, an accessory and the mood's extra (zz, ?, !, sweat…).
 * Presentational: look and mood in, nothing out. Geometry is inline (a few
 * short paths), so no sprite has to be mounted and each avatar is about ten
 * nodes. Motion is CSS keyframes, on only when `animate` is set (callers
 * pass the motion preference); reduced motion in CSS stops it regardless.
 */
import "./moods.css";
import { motion } from "motion/react";
import { useEffect, useId, useState, type CSSProperties } from "react";

import type {
  AvatarAccessory,
  AvatarMood,
  AvatarShape,
  Look,
} from "#next/lib/bots/avatar";
import { cn } from "#next/lib/cn";
import { hatch as hatchMotion, useMotionPreference } from "#next/lib/motion";

/** Border-radius bodies (canvas `radii`). */
const RADII: Partial<Record<AvatarShape, string>> = {
  blob: "46% 54% 52% 48% / 52% 46% 54% 48%",
  round: "50%",
  squircle: "32%",
  pebble: "60% 40% 55% 45% / 50% 60% 40% 50%",
  leaf: "62% 30% 62% 30%",
  drop: "50% 50% 50% 28%",
  bean: "55% 45% 45% 55% / 65% 65% 35% 35%",
  slab: "30% 30% 30% 30% / 44% 44% 44% 44%",
  mochi: "48% 52% 50% 50% / 60% 60% 40% 40%",
  egg: "50% 50% 50% 50% / 62% 62% 38% 38%",
  pillow: "38%",
  jelly: "50% 50% 42% 42% / 56% 56% 44% 44%",
};

/** Path bodies over a 100×100 box (canvas `paths`). */
const PATHS: Partial<Record<AvatarShape, string>> = {
  star: "M50 12 L59 36 L86 38 L65 55 L72 82 L50 68 L28 82 L35 55 L14 38 L41 36 Z",
  flower:
    "M50 4 C62 4 68 16 62 24 C72 20 84 26 84 38 C84 48 74 52 66 50 C74 54 80 66 72 76 C64 84 52 80 50 72 C48 80 36 84 28 76 C20 66 26 54 34 50 C26 52 16 48 16 38 C16 26 28 20 38 24 C32 16 38 4 50 4 Z",
  heart:
    "M50 92 C30 76 6 60 6 36 C6 20 18 8 32 8 C40 8 47 12 50 18 C53 12 60 8 68 8 C82 8 94 20 94 36 C94 60 70 76 50 92 Z",
  cloud:
    "M30 84 C14 84 6 72 10 60 C4 48 14 36 26 38 C26 22 42 12 56 18 C64 8 86 12 86 32 C98 36 98 56 88 62 C94 76 82 86 70 82 C60 92 44 90 30 84 Z",
  hex: "M50 12 L84 31 L84 69 L50 88 L16 69 L16 31 Z",
  gem: "M32 16 L68 16 L86 38 L50 86 L14 38 Z",
  clover:
    "M50 50 C38 30 12 34 14 52 C16 68 38 68 50 54 C62 68 84 68 86 52 C88 34 62 30 50 50 C70 38 66 10 50 12 C34 10 30 38 50 50 C30 62 34 90 50 88 C66 90 70 62 50 50 Z",
  burst:
    "M50 14 L56 28 L68 20 L67 34 L82 34 L72 45 L86 52 L72 58 L78 72 L64 66 L58 80 L50 68 L42 80 L36 66 L22 72 L28 58 L14 52 L28 45 L18 34 L33 34 L32 20 L44 28 Z",
  bunny:
    "M50 30 C30 30 18 44 18 62 C18 80 32 90 50 90 C68 90 82 80 82 62 C82 44 70 30 50 30 Z",
  cat: "M50 26 C30 26 16 42 16 62 C16 80 32 90 50 90 C68 90 84 80 84 62 C84 42 70 26 50 26 Z",
  bear: "M50 24 C30 24 16 40 16 60 C16 78 32 90 50 90 C68 90 84 78 84 60 C84 40 70 24 50 24 Z",
  ghost:
    "M50 8 C28 8 18 26 18 46 L18 88 L30 78 L40 88 L50 78 L60 88 L70 78 L82 88 L82 46 C82 26 72 8 50 8 Z",
};

const EARS: Partial<Record<AvatarShape, string>> = {
  bunny: "M30 34 C24 6 40 0 42 30 M70 34 C76 6 60 0 58 30",
  cat: "M22 40 L20 12 L44 28 M78 40 L80 12 L56 28",
  bear: "M22 34 a10 10 0 1 1 8-14 M78 34 a10 10 0 1 0-8-14",
};

const ACCESSORIES: Record<
  Exclude<AvatarAccessory, "none">,
  { d: string; fill: string; stroke: string }
> = {
  glasses: {
    d: "M18 46a12 10 0 1 0 24 0a12 10 0 1 0-24 0z M58 46a12 10 0 1 0 24 0a12 10 0 1 0-24 0z M42 46h16",
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
    fill: "#17171a",
    stroke: "#17171a",
  },
  antenna: {
    d: "M50 12V-6 M50-10a5 5 0 1 0 0 .1",
    fill: "#e879f9",
    stroke: "#e879f9",
  },
  crown: {
    d: "M22 26 30 2l20 14L70 2l8 24z",
    fill: "#facc15",
    stroke: "#ca8a04",
  },
  monocle: {
    d: "M56 46a13 12 0 1 0 26 0a13 12 0 1 0-26 0z M82 52l8 22",
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
  /** Play the mood's keyframes (pass the motion preference). */
  animate?: boolean;
  /** An accessible name; without one the avatar is decorative. */
  label?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  hatch?: { from: "egg"; onDone(): void };
}

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
  const gradient = useId();
  const path = PATHS[look.shape];
  const ears = EARS[look.shape];
  const radius = RADII[look.shape] ?? RADII.blob;
  const accessory =
    look.accessory === "none" ? null : ACCESSORIES[look.accessory];
  return (
    <span
      className={cn("bav", className)}
      data-slot="bot-avatar"
      data-shape={look.shape}
      data-mood={mood}
      data-animate={animate ? "" : undefined}
      role={label != null ? "img" : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      title={title}
      style={
        {
          "--bav-size": `${size}px`,
          "--bav-color": look.color,
          ...style,
        } as CSSProperties
      }
    >
      {mood === "listening" && (
        <span className="bav-ring" style={{ borderRadius: radius }} />
      )}
      {path == null ? (
        <span className="bav-body" style={{ borderRadius: radius }} />
      ) : (
        <svg className="bav-svg" viewBox="-8 -8 116 116">
          <defs>
            <radialGradient id={gradient} cx="30%" cy="25%" r="75%">
              <stop offset="0" stopColor="#ffffff" stopOpacity=".55" />
              <stop offset=".45" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <g strokeLinejoin="round" strokeLinecap="round">
            <path
              d={path}
              fill={look.color}
              stroke={look.color}
              strokeWidth={16}
            />
            <path
              d={path}
              fill={`url(#${gradient})`}
              stroke={`url(#${gradient})`}
              strokeWidth={16}
            />
            {ears != null && (
              <path
                d={ears}
                fill={look.color}
                stroke={look.color}
                strokeWidth={10}
              />
            )}
          </g>
        </svg>
      )}
      <span className="bav-face">
        {mood === "waiting" && (
          <span className="bav-brows">
            <i />
            <i />
          </span>
        )}
        <span className="bav-eyes">
          <span className="bav-eye" />
          <span className="bav-eye" />
        </span>
        <span className="bav-mouth" />
      </span>
      <span className="bav-cheeks">
        <i />
        <i />
      </span>
      {accessory != null && (
        <svg
          className="bav-acc"
          viewBox="0 0 100 100"
          data-accessory={look.accessory}
        >
          <path
            d={accessory.d}
            fill={accessory.fill}
            stroke={accessory.stroke}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      <Extra mood={mood} />
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
