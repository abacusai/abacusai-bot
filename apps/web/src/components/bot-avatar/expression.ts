import type { AvatarMood, AvatarShape } from "#renderer/lib/bots/avatar";

/** One numeric pose in a 100-unit drawing. Positive smile curves down. */
export interface Expression {
  eyes: number;
  wink: number;
  gazeX: number;
  gazeY: number;
  brow: number;
  browTilt: number;
  smile: number;
  mouthOpen: number;
  mouthWidth: number;
  mouthX: number;
  cheek: number;
  lift: number;
  lean: number;
  stretch: number;
  lidCurve: number;
  overlap: number;
}
const rest: Expression = {
  eyes: 1,
  wink: 1,
  gazeX: 0,
  gazeY: 0,
  brow: 0,
  browTilt: 0,
  smile: 4,
  mouthOpen: 0,
  mouthWidth: 16,
  mouthX: 0,
  cheek: 0.16,
  lift: 0,
  lean: 0,
  stretch: 1,
  lidCurve: 0,
  overlap: 0,
};
const poses: Record<AvatarMood, Partial<Expression>> = {
  idle: {},
  thinking: {
    eyes: 0.85,
    gazeX: 3,
    gazeY: -3,
    brow: 2,
    browTilt: -2,
    smile: 0,
    mouthWidth: 9,
    mouthX: 3,
    lean: -3,
  },
  working: {
    eyes: 0.8,
    brow: -1,
    browTilt: 2,
    smile: 1,
    mouthWidth: 11,
    lean: 2,
  },
  waiting: {
    eyes: 1.05,
    gazeY: -1,
    brow: 3,
    browTilt: -2,
    smile: 1,
    mouthWidth: 9,
  },
  blocked: {
    eyes: 0.65,
    brow: 1,
    browTilt: -5,
    smile: -3,
    mouthWidth: 12,
    mouthX: 1,
    lean: -3,
  },
  done: {
    eyes: 0.06,
    lidCurve: -5,
    smile: 8,
    mouthOpen: 3,
    mouthWidth: 22,
    cheek: 0.65,
    lift: -2,
    stretch: 1.03,
  },
  talking: {
    eyes: 0.95,
    brow: 1,
    smile: 3,
    mouthOpen: 6,
    mouthWidth: 17,
    cheek: 0.24,
  },
  listening: {
    eyes: 1.16,
    gazeX: 1,
    brow: 3,
    smile: 1,
    mouthWidth: 7,
    lean: 4,
    stretch: 1.02,
  },
  happy: {
    eyes: 0.06,
    lidCurve: -5,
    smile: 8,
    mouthOpen: 2,
    mouthWidth: 22,
    cheek: 0.7,
    lift: -1,
  },
  asleep: {
    eyes: 0.04,
    lidCurve: 2,
    gazeY: 0,
    smile: 0,
    mouthOpen: 1.5,
    mouthWidth: 5,
    lean: -5,
    stretch: 0.97,
  },
  surprised: {
    eyes: 1.25,
    brow: 6,
    mouthOpen: 10,
    mouthWidth: 9,
    smile: 0,
    lift: -2,
    stretch: 1.04,
  },
  wink: {
    wink: 0.04,
    lidCurve: -3,
    smile: 6,
    mouthWidth: 19,
    mouthX: 2,
    cheek: 0.5,
    lean: -4,
  },
  love: {
    eyes: 0.06,
    lidCurve: -5,
    smile: 7,
    mouthWidth: 19,
    cheek: 0.8,
    lean: -3,
  },
  confused: {
    eyes: 0.85,
    wink: 0.65,
    gazeX: -1,
    brow: 3,
    browTilt: 5,
    smile: -1,
    mouthX: 3,
    mouthWidth: 11,
    lean: 7,
  },
  sad: {
    eyes: 0.65,
    gazeY: 2,
    brow: 1,
    browTilt: -5,
    smile: -6,
    mouthWidth: 16,
    cheek: 0.12,
    lift: 2,
    lean: -3,
    stretch: 0.97,
  },
  focused: {
    eyes: 0.55,
    brow: -2,
    browTilt: 4,
    smile: 0,
    mouthWidth: 10,
    stretch: 0.99,
  },
  excited: {
    eyes: 0.06,
    lidCurve: -6,
    brow: 3,
    smile: 9,
    mouthOpen: 5,
    mouthWidth: 24,
    cheek: 0.75,
    lift: -3,
    stretch: 1.05,
  },
  error: {
    eyes: 1.1,
    brow: 4,
    browTilt: -6,
    smile: -4,
    mouthOpen: 3,
    mouthWidth: 12,
    lean: -4,
    stretch: 0.96,
  },
};
export const expressionFor = (mood: AvatarMood): Expression => {
  const pose = { ...rest, ...poses[mood] };
  pose.overlap = -pose.lean * 0.6;
  return pose;
};

export const opticalSize = (size: number) => ({
  tiny: size <= 24,
  eyeRadius: size <= 24 ? 6.8 : size <= 44 ? 6.1 : 5.7,
  eyeSpacing: size <= 24 ? 14 : 13,
  line: Math.max(2.2, 100 / Math.max(1, size)),
  cheeks: size > 24,
  brows: size >= 32,
  highlights: size >= 32,
  particles: size >= 32,
});

export interface Personality {
  period: number;
  weight: number;
  bounce: number;
  sway: number;
}
const soft: Personality = { period: 4.8, weight: 1, bounce: 0.7, sway: 0.7 };
/** Weight controls spring mass; period and amplitude keep the same rig individual. */
export const personalityFor = (shape: AvatarShape): Personality => {
  switch (shape) {
    case "pebble":
    case "slab":
    case "hex":
    case "gem":
      return { period: 6.8, weight: 1.8, bounce: 0.25, sway: 0.3 };
    case "jelly":
    case "blob":
    case "mochi":
    case "pillow":
    case "bean":
      return { period: 4.2, weight: 0.8, bounce: 1.2, sway: 0.8 };
    case "bunny":
      return { period: 3.8, weight: 0.7, bounce: 1.7, sway: 0.6 };
    case "ghost":
    case "cloud":
      return { period: 6, weight: 0.9, bounce: 1.5, sway: 1.1 };
    case "cat":
    case "leaf":
      return { period: 5.6, weight: 1.1, bounce: 0.35, sway: 0.45 };
    case "star":
    case "flower":
    case "heart":
    case "clover":
    case "burst":
      return { period: 4.4, weight: 0.8, bounce: 0.9, sway: 1.2 };
    case "bear":
    case "egg":
      return { period: 5.8, weight: 1.4, bounce: 0.5, sway: 0.6 };
    default:
      return soft;
  }
};
const noise = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
/** Deterministic, irregular lids. Occasional second closure follows the first. */
export const blinkAt = (seconds: number, seed: number): number => {
  const cycle = Math.floor((seconds + seed) / 6.7);
  const t = (seconds + seed) % 6.7;
  const start = 2 + noise(cycle + seed) * 3.6;
  const closure = (offset: number) =>
    Math.max(0, 1 - Math.abs(t - start - offset) / 0.12);
  return (
    1 - Math.max(closure(0), noise(cycle + seed + 8) > 0.72 ? closure(0.3) : 0)
  );
};
/** Shared-clock sample. Everything added here agrees with the expression pose. */
export const sampleExpression = (
  mood: AvatarMood,
  shape: AvatarShape,
  seconds: number,
  seed: number
): Expression => {
  const p = expressionFor(mood);
  const character = personalityFor(shape);
  const phase = ((seconds + seed) * Math.PI * 2) / character.period;
  const breath = Math.sin(phase);
  p.stretch *=
    1 + breath * (mood === "asleep" ? 0.018 : 0.009) * character.bounce;
  p.lift +=
    breath *
    character.bounce *
    (shape === "ghost" || shape === "cloud" ? 1.5 : 0.4);
  p.lean += Math.sin(phase * 0.5) * character.sway;
  if (shape === "jelly") {
    p.stretch += Math.sin(phase * 2) * 0.015;
    p.lean += Math.sin(phase + 0.8) * 0.7;
  }
  // One quiet hop, with a crouch and a softer landing, then a long rest.
  if (shape === "bunny" && mood !== "asleep") {
    const hop = (seconds + seed) % 8;
    if (hop < 0.25) {
      p.stretch *= 0.96;
      p.lift += 1;
    } else if (hop < 0.9) {
      const arc = Math.sin(((hop - 0.25) / 0.65) * Math.PI);
      p.lift -= arc * 3.5;
      p.stretch *= 1 + arc * 0.035;
    } else if (hop < 1.2)
      p.stretch *= 1 - Math.sin(((hop - 0.9) / 0.3) * Math.PI) * 0.025;
  }
  if (p.eyes > 0.2) {
    const blink = blinkAt(seconds, seed);
    p.eyes *= blink;
    if (blink < 0.2) p.lidCurve = 1;
  }
  if (["idle", "working", "listening", "waiting"].includes(mood)) {
    const dart = Math.floor((seconds + seed) / 3.7);
    p.gazeX += (noise(dart + seed) - 0.5) * 3;
    p.gazeY += (noise(dart + seed + 4) - 0.5) * 1.4;
  }
  if (mood === "talking") {
    const syllable = Math.max(
      0,
      Math.sin(seconds * 15 + seed) * 0.6 +
        Math.sin(seconds * 23 + seed * 2) * 0.4
    );
    const pause = Math.sin(seconds * 1.7 + seed) > -0.7 ? 1 : 0.12;
    p.mouthOpen = 0.8 + syllable * 9 * pause;
    p.mouthWidth = 13 + (1 - syllable) * 6;
    p.brow += syllable;
    p.stretch += syllable * 0.009;
    p.lift -= syllable * 0.5;
  }
  p.overlap = -p.lean * 0.6;
  return p;
};

/** Same topology for closed smiles, frowns and open visemes, so paths blend. */
export const mouthPath = (p: Expression, widthScale = 1): string => {
  const half = (p.mouthWidth * widthScale) / 2;
  const x = 50 + p.mouthX;
  const y = 64;
  return `M${x - half} ${y} Q${x} ${y + p.smile} ${x + half} ${y} Q${x} ${y + p.smile + p.mouthOpen * 2} ${x - half} ${y} Z`;
};
