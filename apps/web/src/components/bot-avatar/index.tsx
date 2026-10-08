/** A coordinated SVG character rig. Public look, mood and hatch props stay stable. */
import "./moods.css";
import { AnimatePresence, motion, useTransform } from "motion/react";
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

import {
  expressionFor,
  opticalSize,
  personalityFor,
  type ExpressionMix,
} from "./expression";
import { BODIES, EARS } from "./geometry";
import { useAvatarExperiments, useNaturalMotion } from "./natural";
import { useOutline } from "./outline";
import {
  faceProportions,
  personalityFromIdentity,
  personalityIdentity,
  type AvatarPersonality,
} from "./personality";
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
  /** Optional character pose or mix, independent of lifecycle and particles. */
  expression?: ExpressionMix;
  /** Detailed outline morphing is reserved for the one live edit preview. */
  morph?: boolean;
  /** Rendered size in px (22 title bar, 36 sidebar, 56 transcript, 96 setup). */
  size: number;
  /** Allow character motion, subject to visibility and motion preference. */
  animate?: boolean;
  /** Pointer gaze/lean/press feedback; tiny/static contexts opt out. */
  interactive?: boolean;
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
  personality,
}: {
  x: number;
  rig: ReturnType<typeof useFaceRig>["rig"];
  optics: ReturnType<typeof opticalSize>;
  left: boolean;
  personality: AvatarPersonality;
}) => {
  const lidClip = useId();
  const opening = useTransform(() =>
    Math.max(
      0.025,
      rig.eyes.get() * (left ? rig.wink.get() : rig.rightEye.get())
    )
  );
  const pupil = useTransform(
    () =>
      `translate(${rig.gazeX.get() + (left ? -1 : 1) * rig.gazeSplit.get()}px, ${rig.gazeY.get()}px) scale(${Math.min(1.12, Math.max(1, opening.get()))})`
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
  const eyePosition = useTransform(
    () => `translateY(${(left ? -1 : 1) * rig.eyeOffset.get()}px)`
  );
  const sparkle = useTransform(() => 0.95 * rig.sparkle.get());
  const brow = useTransform(
    () =>
      `M${x - 6} ${34 - rig.brow.get() * (left ? personality.leftBrowGain : personality.rightBrowGain) - (left ? 1 : -1) * rig.browAsymmetry.get() + ((left ? -1 : 1) * rig.browTilt.get()) / 2} Q${x} ${34 - personality.browArch - rig.brow.get() * (left ? personality.leftBrowGain : personality.rightBrowGain) - (left ? 1 : -1) * rig.browAsymmetry.get()} ${x + 6} ${34 - rig.brow.get() * (left ? personality.leftBrowGain : personality.rightBrowGain) - (left ? 1 : -1) * rig.browAsymmetry.get() + ((left ? 1 : -1) * rig.browTilt.get()) / 2}`
  );
  return (
    <motion.g className="bav-eye" style={{ transform: eyePosition }}>
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
          strokeWidth={optics.line * 0.8 * personality.browThickness}
          strokeLinecap="round"
          opacity={0.8}
        />
      )}
      <g
        className="bav-eye-open"
        clipPath={`url(#${lidClip})`}
        style={{ transformOrigin: `${x}px 47px` }}
      >
        <g className="bav-gaze">
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
              rx={optics.eyeRadius * personality.pupilSize}
              ry={optics.eyeRadius * personality.eyeAspect}
              fill="var(--bav-ink)"
            />
            {optics.highlights && (
              <>
                <motion.ellipse
                  cx={x + personality.highlightX}
                  cy={47 + personality.highlightY}
                  rx={1.8}
                  ry={2.2}
                  fill="white"
                  style={{ opacity: sparkle }}
                />
                <circle cx={x + 2} cy={49} r={0.8} fill="white" opacity={0.4} />
              </>
            )}
          </motion.g>
        </g>
      </g>
      <motion.path
        d={lid}
        style={{ opacity: closed }}
        stroke="var(--bav-ink)"
        strokeWidth={optics.line}
        fill="none"
        strokeLinecap="round"
      />
    </motion.g>
  );
};

const AvatarBody = ({
  look,
  mood = "idle",
  expression,
  morph = false,
  size,
  animate = false,
  interactive = true,
  label,
  title,
  className,
  style,
}: BotAvatarProps) => {
  const reduced = useMotionPreference() === "reduced";
  const gradient = useId();
  const experiments = useAvatarExperiments();
  const identity = personalityIdentity(look);
  const personality = personalityFromIdentity(
    experiments?.individuality === false ? "baseline" : identity
  );
  const proportions = faceProportions(look.shape, personality);
  const baseOptics = opticalSize(size);
  const optics = {
    ...baseOptics,
    eyeRadius: baseOptics.eyeRadius * proportions.eyeSize,
    eyeSpacing: baseOptics.eyeSpacing * proportions.eyeSpacing,
  };
  const rootRef = useRef<HTMLSpanElement>(null);
  const faceRig = useFaceRig(
    mood,
    look.shape,
    animate && !reduced,
    size,
    rootRef,
    expression,
    interactive,
    personality,
    experiments?.coupling ?? true
  );
  const { rig } = faceRig;
  useNaturalMotion(
    rootRef,
    faceRig.active && size > 44,
    identity,
    personality,
    mood,
    expressionFor(mood, expression).eyes,
    experiments
  );
  const outline = useOutline(look, faceRig.active && morph);
  const shadowColor = useTransform(
    () => `color-mix(in srgb, ${outline.color.get()} 20%, transparent)`
  );
  const partTransition = { duration: faceRig.active ? 0.24 : 0 };
  const ears = EARS[look.shape];
  const accessory =
    look.accessory === "none" ? null : ACCESSORIES[look.accessory];
  const tongue = useTransform(
    () =>
      Math.min(1, rig.mouthOpen.get() / 5) *
      Math.max(0, Math.min(1, rig.smile.get() / 3))
  );
  return (
    <span
      ref={rootRef}
      className={cn("bav", className)}
      data-slot="bot-avatar"
      data-interactive={interactive ? "" : undefined}
      data-shape={look.shape}
      data-mood={mood}
      data-steady={faceRig.steady ? "" : undefined}
      data-animate={faceRig.active ? "" : undefined}
      data-optical={optics.tiny ? "tiny" : "full"}
      data-natural=""
      data-shading={experiments?.shading === false ? "off" : "on"}
      role={label != null ? "img" : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      title={title}
      onPointerEnter={faceRig.onPointerEnter}
      onPointerMove={faceRig.onPointerMove}
      onPointerLeave={faceRig.onPointerLeave}
      onPointerDown={faceRig.onPointerDown}
      onPointerUp={faceRig.onPointerUp}
      onPointerCancel={faceRig.onPointerCancel}
      style={
        {
          "--bav-size": `${size}px`,
          "--bav-color": look.color,
          "--bav-period": `${personalityFor(look.shape).period * personality.period}s`,
          "--bav-phase": `${experiments?.phase === false ? 0 : -personality.phase}s`,
          "--bav-breath": personality.breath,
          "--bav-hop": personality.hop,
          "--bav-wobble": personality.wobble,
          ...style,
        } as CSSProperties
      }
    >
      <motion.span
        className="bav-shadow"
        style={{
          transform: faceRig.shadow,
          opacity: faceRig.shadowOpacity,
          background: faceRig.active ? shadowColor : undefined,
        }}
      />
      <span className="bav-life">
        <span className="bav-attention">
          <motion.span
            className="bav-character"
            style={{ transform: faceRig.body }}
          >
            <motion.svg
              style={{ transform: faceRig.deform }}
              className="bav-svg"
              viewBox="0 0 100 100"
              aria-hidden="true"
            >
              <defs>
                <motion.radialGradient
                  id={gradient}
                  cx={faceRig.lightX}
                  cy={faceRig.lightY}
                  r="90%"
                >
                  <stop offset="0" stopColor="white" stopOpacity=".5" />
                  <stop offset=".48" stopColor="white" stopOpacity=".06" />
                  <stop offset="1" stopColor="#172437" stopOpacity=".19" />
                </motion.radialGradient>
                <clipPath id={`${gradient}-body`}>
                  <path d={BODIES[look.shape]} />
                </clipPath>
                <clipPath id={`${gradient}-mouth`}>
                  <motion.path d={faceRig.mouth} />
                </clipPath>
              </defs>
              <AnimatePresence initial={false}>
                {ears && (
                  <motion.g
                    key={look.shape}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={partTransition}
                    className="bav-ears bav-turn-parts"
                    style={{
                      rotate: faceRig.secondary,
                      transformOrigin: "50px 40px",
                    }}
                  >
                    <motion.path
                      d={ears}
                      fill={
                        faceRig.active && morph ? outline.color : look.color
                      }
                    />
                    <path
                      d={ears}
                      fill={`url(#${gradient})`}
                      className="bav-light"
                    />
                    <path
                      d={ears}
                      fill="#ffadc4"
                      opacity=".2"
                      transform="translate(10 6) scale(.8)"
                    />
                  </motion.g>
                )}
              </AnimatePresence>
              <motion.path
                className="bav-body"
                d={faceRig.active && morph ? outline.path : BODIES[look.shape]}
                fill={faceRig.active && morph ? outline.color : look.color}
              />
              <motion.path
                d={faceRig.active && morph ? outline.path : BODIES[look.shape]}
                fill={`url(#${gradient})`}
                className="bav-light"
                stroke="white"
                strokeOpacity=".25"
                strokeWidth=".8"
              />
              <g clipPath={`url(#${gradient}-body)`}>
                <g
                  className="bav-volume"
                  style={{ transformOrigin: "50px 50px" }}
                >
                  <motion.g
                    style={{
                      transform:
                        faceRig.active && morph
                          ? outline.facePosition
                          : `translateY(${(ears ? 9 : look.shape === "heart" ? -3 : 0) + proportions.faceY}px)`,
                    }}
                  >
                    <motion.g
                      className="bav-face"
                      style={{ transform: faceRig.face }}
                    >
                      {optics.cheeks && (
                        <motion.g
                          className="bav-cheeks"
                          style={{ opacity: faceRig.cheek }}
                        >
                          <ellipse
                            cx="25"
                            cy="60"
                            rx="7"
                            ry="3.8"
                            fill="#f2769c"
                          />
                          <ellipse
                            cx="75"
                            cy="60"
                            rx="7"
                            ry="3.8"
                            fill="#f2769c"
                          />
                        </motion.g>
                      )}
                      <Eye
                        x={50 - optics.eyeSpacing}
                        rig={rig}
                        optics={optics}
                        left
                        personality={personality}
                      />
                      <Eye
                        x={50 + optics.eyeSpacing}
                        rig={rig}
                        optics={optics}
                        left={false}
                        personality={personality}
                      />
                      <g
                        className="bav-speech"
                        style={{ transformOrigin: "50px 64px" }}
                      >
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
                      </g>
                    </motion.g>
                    <AnimatePresence initial={false}>
                      {accessory &&
                        ["glasses", "monocle", "shades"].includes(
                          look.accessory
                        ) && (
                          <motion.g
                            key={look.accessory}
                            initial={{ opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.85 }}
                            transition={partTransition}
                            className="bav-acc"
                            data-accessory={look.accessory}
                            style={{
                              transform: faceRig.face,
                              transformOrigin: "50px 47px",
                            }}
                          >
                            <path
                              d={accessory.d}
                              fill={accessory.fill}
                              stroke={accessory.stroke}
                              strokeWidth="2.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </motion.g>
                        )}
                    </AnimatePresence>
                  </motion.g>
                </g>
              </g>
              <AnimatePresence initial={false}>
                {accessory &&
                  !["glasses", "monocle", "shades"].includes(
                    look.accessory
                  ) && (
                    <motion.g
                      key={look.accessory}
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85 }}
                      transition={partTransition}
                      className="bav-acc bav-turn-parts"
                      data-accessory={look.accessory}
                      style={{
                        rotate: faceRig.secondary,
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
              </AnimatePresence>
            </motion.svg>
            {optics.particles && <Extra mood={mood} />}
          </motion.span>
        </span>
      </span>
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
