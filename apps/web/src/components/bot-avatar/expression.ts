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
  rightEye: number;
  eyeOffset: number;
  gazeSplit: number;
  browAsymmetry: number;
  cornerTilt: number;
  sparkle: number;
  waveX: number;
  waveY: number;
  tiltX: number;
  tiltY: number;
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
  rightEye: 1,
  eyeOffset: 0,
  gazeSplit: 0,
  browAsymmetry: 0,
  cornerTilt: 0,
  sparkle: 1,
  waveX: 0,
  waveY: 0,
  tiltX: 0,
  tiltY: 0,
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
export const NAMED_EXPRESSIONS = [
  "curious",
  "skeptical",
  "hopeful",
  "determined",
  "worried",
  "proud",
  "shy",
  "tiredHappy",
] as const;
export type ExpressionName = (typeof NAMED_EXPRESSIONS)[number];
export type ExpressionMix =
  | ExpressionName
  | { from: ExpressionName; to: ExpressionName; mix: number };
const named: Record<ExpressionName, Partial<Expression>> = {
  curious: {
    eyes: 1.08,
    wink: 0.86,
    gazeX: 2,
    gazeY: -2,
    brow: 3,
    browAsymmetry: 3,
    gazeSplit: -0.2,
    smile: 2,
    mouthWidth: 10,
    mouthX: 2,
    cornerTilt: -1.5,
    lean: -4,
  },
  skeptical: {
    eyes: 0.65,
    rightEye: 1.5,
    brow: 1,
    browAsymmetry: 5,
    browTilt: 2,
    eyeOffset: 1,
    gazeSplit: 0.5,
    gazeX: -2,
    smile: 0,
    mouthWidth: 12,
    mouthX: 2,
    cornerTilt: 2,
    cheek: 0.08,
    lean: 4,
  },
  hopeful: {
    eyes: 1.12,
    brow: 4,
    browTilt: -2,
    browAsymmetry: 1.5,
    gazeY: -1.5,
    smile: 3,
    mouthWidth: 11,
    cheek: 0.3,
    sparkle: 1.2,
    eyeOffset: -0.2,
    lean: -2,
  },
  determined: {
    eyes: 0.72,
    wink: 0.9,
    brow: -1,
    browTilt: 5,
    browAsymmetry: 0.8,
    smile: 0.8,
    mouthWidth: 11,
    cornerTilt: -1,
    gazeSplit: 0.15,
    lean: 2,
    sparkle: 0.8,
  },
  worried: {
    eyes: 0.9,
    rightEye: 1.08,
    brow: 3,
    browTilt: -6,
    browAsymmetry: 1,
    smile: -4,
    mouthWidth: 11,
    mouthOpen: 0.4,
    gazeY: 1,
    cornerTilt: 1,
    gazeSplit: -0.35,
    cheek: 0.1,
    stretch: 0.98,
  },
  proud: {
    eyes: 0.5,
    brow: 2,
    browAsymmetry: 1.5,
    smile: 6,
    mouthWidth: 19,
    mouthX: 1,
    cornerTilt: -2,
    cheek: 0.45,
    lift: -1,
    lean: -3,
  },
  shy: {
    eyes: 0.75,
    wink: 0.85,
    gazeX: -2,
    gazeY: 2,
    brow: 1,
    browTilt: -2,
    browAsymmetry: 2,
    smile: 4,
    mouthWidth: 9,
    mouthX: -2,
    cornerTilt: 1.5,
    cheek: 0.75,
    lean: 4,
    sparkle: 0.75,
    eyeOffset: 0.5,
  },
  tiredHappy: {
    eyes: 0.38,
    brow: 1,
    browAsymmetry: 1,
    smile: 5,
    mouthWidth: 17,
    cheek: 0.35,
    gazeY: 1,
    lean: -3,
    stretch: 0.99,
    sparkle: 0.65,
  },
};
const contextual: Partial<Record<AvatarMood, ExpressionName>> = {
  waiting: "hopeful",
  working: "determined",
  error: "worried",
  thinking: "curious",
};
export const namedExpression = (name: ExpressionName): Expression => ({
  ...rest,
  ...named[name],
});
export const blendExpressions = (
  a: Expression,
  b: Expression,
  mix: number
): Expression => {
  const t = Math.max(0, Math.min(1, mix));
  if (t === 0) return { ...a };
  if (t === 1) return { ...b };
  return Object.fromEntries(
    Object.keys(a).map((key) => {
      const k = key as keyof Expression;
      return [k, a[k] + (b[k] - a[k]) * t];
    })
  ) as unknown as Expression;
};
export const expressionFor = (
  mood: AvatarMood,
  expression?: ExpressionMix
): Expression => {
  const selection = expression ?? contextual[mood];
  const pose = selection
    ? typeof selection === "string"
      ? namedExpression(selection)
      : blendExpressions(
          namedExpression(selection.from),
          namedExpression(selection.to),
          selection.mix
        )
    : { ...rest, ...poses[mood] };
  if (!expression && mood === "confused") {
    pose.browAsymmetry = 4;
    pose.eyeOffset = 1.5;
    pose.cornerTilt = 2;
  }
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
  softness?: number;
}
const soft: Personality = { period: 4.8, weight: 1, bounce: 0.7, sway: 0.7 };
/** Weight controls spring mass; period and amplitude keep the same rig individual. */
export const personalityFor = (shape: AvatarShape): Personality => {
  switch (shape) {
    case "pebble":
    case "slab":
    case "hex":
    case "gem":
      return {
        period: 6.8,
        weight: 1.8,
        bounce: 0.25,
        sway: 0.3,
        softness: 0.18,
      };
    case "jelly":
    case "blob":
    case "mochi":
    case "pillow":
    case "bean":
      return {
        period: 4.2,
        weight: 0.8,
        bounce: 1.2,
        sway: 0.8,
        softness: shape === "jelly" ? 1.8 : 1.1,
      };
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
  seed: number,
  expression?: ExpressionMix
): Expression => {
  const p = expressionFor(mood, expression);
  const character = personalityFor(shape);
  const phase = ((seconds + seed) * Math.PI * 2) / character.period;
  const breath = Math.sin(phase);
  const softness = character.softness ?? 0.65;
  p.waveX = Math.sin(phase * 1.7) * softness;
  p.waveY = Math.cos(phase * 1.3 + 0.7) * softness * 0.7;
  p.tiltX = p.gazeX * 0.6;
  p.tiltY = p.gazeY * 0.5;
  // A small brow flick leads the work glance; the mouth keeps its intent.
  if (["working", "waiting", "listening"].includes(mood)) {
    const flick = (seconds + seed) % 7.3;
    if (flick < 0.45)
      p.browAsymmetry += Math.sin((flick / 0.45) * Math.PI) * 1.5;
  }
  if (["excited", "done", "surprised"].includes(mood)) {
    const cycle = mood === "excited" ? 1.8 : mood === "done" ? 3.8 : 5.8;
    const t = (seconds + seed) % cycle;
    if (t < 0.18) {
      p.stretch *= 0.94;
      p.lift += 1;
    } else if (t < 0.7) {
      const arc = Math.sin(((t - 0.18) / 0.52) * Math.PI);
      p.lift -= arc * (mood === "excited" ? 5 : 3) * character.bounce;
      p.stretch *= 1 + arc * 0.045;
      p.lean += Math.sin(((t - 0.18) / 0.52) * Math.PI * 2) * 2;
    } else if (t < 1.2) {
      const settle = Math.sin((t - 0.7) * 16) * Math.exp(-(t - 0.7) * 6);
      p.waveX += settle * softness * 3;
      p.waveY -= settle * softness * 2;
      p.stretch *= 1 - settle * 0.035;
    }
  }
  if (mood === "error") {
    const shake = (seconds + seed) % 5;
    if (shake < 0.65) {
      p.lean += Math.sin(shake * 24) * 3 * Math.exp(-shake * 3);
      p.waveX += Math.sin(shake * 24) * softness;
    }
  }

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
    p.lift -= syllable * 1.2;
    p.waveY += syllable * softness * 0.8;
  }
  p.overlap = -p.lean * 0.6;
  return p;
};

/** A short event impulse: anticipation, action on an arc, then overlapping settle. */
export const entryExpression = (
  pose: Expression,
  mood: AvatarMood,
  shape: AvatarShape,
  elapsed: number,
  changingLook = false
): Expression => {
  const p = { ...pose };
  const personality = personalityFor(shape);
  const celebrating =
    changingLook || ["done", "excited", "surprised"].includes(mood);
  if (elapsed >= 0 && elapsed < 0.1) {
    p.browAsymmetry += 1.2;
    if (celebrating) {
      p.stretch = 0.96;
      p.lift = 1;
    }
  }
  const t = elapsed - 0.1;
  if (t >= 0 && t < 0.7 && celebrating) {
    const arc = Math.sin(Math.min(1, t / 0.55) * Math.PI);
    const settle = Math.sin(t * 18) * Math.exp(-t * 5);
    p.lift -= arc * 2.5 * personality.bounce;
    p.stretch *= 1 + arc * 0.04;
    p.waveX += settle * (personality.softness ?? 0.65) * 2;
    p.waveY -= settle * (personality.softness ?? 0.65);
  }
  if (mood === "error" && t >= 0 && t < 0.6)
    p.lean += Math.sin(t * 24) * Math.exp(-t * 5) * 3;
  return p;
};

/** Same topology for closed smiles, frowns and open visemes, so paths blend. */
export const mouthPath = (p: Expression, widthScale = 1): string => {
  const half = (p.mouthWidth * widthScale) / 2;
  const x = 50 + p.mouthX;
  const y = 64;
  const leftY = y - p.cornerTilt;
  const rightY = y + p.cornerTilt;
  const top = y + p.smile - p.mouthOpen * 0.65;
  const bottom = y + p.smile + p.mouthOpen * 1.35;
  return `M${x - half} ${leftY} C${x - half} ${top} ${x + half} ${top} ${x + half} ${rightY} C${x + half} ${bottom} ${x - half} ${bottom} ${x - half} ${leftY} Z`;
};
