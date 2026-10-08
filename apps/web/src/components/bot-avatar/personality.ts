import type { AvatarShape, Look } from "#renderer/lib/bots/avatar";

/** Small independent traits in drawing units, seconds and dimensionless gains. */
export const TRAIT_BOUNDS = {
  eyeSize: [0.91, 1.09],
  eyeSpacing: [0.94, 1.06],
  faceY: [-1.3, 1.3],
  eyeAspect: [1.02, 1.38],
  pupilSize: [0.94, 1.06],
  highlightX: [-2.3, -1.3],
  highlightY: [-3.5, -2.5],
  browThickness: [0.85, 1.12],
  browArch: [1.1, 2.9],
  browAngle: [-0.9, 0.9],
  leftBrowGain: [0.88, 1.12],
  rightBrowGain: [0.88, 1.12],
  mouthWidth: [0.91, 1.09],
  smileBias: [-0.7, 0.7],
  smileAsymmetry: [0.15, 0.7],
  blush: [0.8, 1.15],
  blinkGap: [3.8, 6.8],
  blinkDuration: [0.16, 0.24],
  doubleBlink: [0.08, 0.22],
  saccadeGap: [2.2, 4.8],
  saccadeAmplitude: [0.65, 1.6],
  gazeX: [-0.45, 0.45],
  gazeY: [-0.4, 0.4],
  phase: [0, 83],
  period: [0.92, 1.12],
  breath: [0.7, 1.15],
  hop: [0.78, 1.12],
  wobble: [0.8, 1.1],
  stiffness: [0.9, 1.12],
  latency: [0.02, 0.09],
  expressiveness: [0.82, 1.02],
  tilt: [-0.8, 0.8],
  speechPeriod: [4.8, 7.2],
} as const;
export type AvatarPersonality = {
  readonly [K in keyof typeof TRAIT_BOUNDS]: number;
} & {
  readonly handedness: -1 | 1;
};

/** Avalanche each salted trait independently; adjacent IDs must not look alike. */
export const identityNoise = (identity: string, salt: number): number => {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < identity.length; i++)
    h = Math.imul(h ^ identity.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export const personalityFromIdentity = (
  identity: string
): AvatarPersonality => {
  const traits = Object.fromEntries(
    Object.entries(TRAIT_BOUNDS).map(([key, [lo, hi]], i) => [
      key,
      lo + identityNoise(identity, i + 1) * (hi - lo),
    ])
  ) as Omit<AvatarPersonality, "handedness">;
  return { ...traits, handedness: identityNoise(identity, 97) < 0.5 ? -1 : 1 };
};
export const personalityIdentity = (look: Look): string =>
  look.identity ?? `${look.shape}:${look.color}:${look.accessory}`;

/** Pointed silhouettes reserve the same safe face island as the contour rig. */
export const faceProportions = (shape: AvatarShape, p: AvatarPersonality) => {
  const compact = [
    "star",
    "flower",
    "clover",
    "burst",
    "heart",
    "drop",
    "leaf",
  ].includes(shape);
  return {
    eyeSize: p.eyeSize * (compact ? 0.96 : 1),
    eyeSpacing: p.eyeSpacing * (compact ? 0.95 : 1),
    faceY: p.faceY,
  };
};
