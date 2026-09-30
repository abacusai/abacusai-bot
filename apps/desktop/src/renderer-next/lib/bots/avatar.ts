/**
 * The bot look scheme (spec 03 §14; the spec's `shared/bots/avatar.ts`,
 * kept in renderer-next because the old renderer does not use it): 24
 * shapes, 10 colours, 8 accessories, the moods, the legacy mapping and the
 * name-hash default. Pure; nothing here is written back to disk (§14.3).
 */
import { accentForeground, contrastRatio } from "#next/lib/theme";

/** Canvas order: 12 CSS bodies, then 12 SVG bodies. */
export const AVATAR_SHAPES = [
  "blob",
  "round",
  "squircle",
  "pebble",
  "leaf",
  "drop",
  "bean",
  "slab",
  "mochi",
  "egg",
  "pillow",
  "jelly",
  "star",
  "flower",
  "heart",
  "cloud",
  "hex",
  "gem",
  "clover",
  "burst",
  "bunny",
  "cat",
  "bear",
  "ghost",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** The name hash picks among the first 16 (canvas BotNew). */
export const DEFAULT_SHAPES: readonly AvatarShape[] = AVATAR_SHAPES.slice(
  0,
  16
);

/** The setup column's first row (canvas BotCreate). */
export const SETUP_SHAPES = [
  "blob",
  "mochi",
  "pebble",
  "bunny",
  "cat",
  "bear",
  "star",
  "cloud",
] as const satisfies readonly AvatarShape[];

/** The start page's strip (canvas BotNew). */
export const START_SHAPES = [
  "blob",
  "round",
  "star",
  "flower",
  "heart",
  "cloud",
  "clover",
  "burst",
] as const satisfies readonly AvatarShape[];

export const LIFECYCLE_MOODS = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
  "asleep",
] as const;
export type LifecycleMood = (typeof LIFECYCLE_MOODS)[number];

/** Layered on the lifecycle for 600 ms (`talking` lasts while text streams). */
export const REACTION_MOODS = [
  "talking",
  "listening",
  "happy",
  "surprised",
  "wink",
  "love",
  "confused",
  "sad",
  "focused",
  "excited",
  "error",
] as const;
export type ReactionMood = (typeof REACTION_MOODS)[number];

export type AvatarMood = LifecycleMood | ReactionMood;

export const AVATAR_ACCESSORIES = [
  "none",
  "glasses",
  "shades",
  "bow",
  "cap",
  "headphones",
  "antenna",
  "crown",
  "monocle",
] as const;
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];

/** Tailwind-400 swatches (canvas BotCreate/Avatars); `id` names the i18n key. */
export const AVATAR_PALETTE = [
  { id: "green", hex: "#4ade80" },
  { id: "blue", hex: "#60a5fa" },
  { id: "purple", hex: "#c084fc" },
  { id: "pink", hex: "#f472b6" },
  { id: "red", hex: "#f87171" },
  { id: "orange", hex: "#fb923c" },
  { id: "yellow", hex: "#facc15" },
  { id: "teal", hex: "#2dd4bf" },
  { id: "indigo", hex: "#818cf8" },
  { id: "stone", hex: "#a8a29e" },
] as const;
export type AvatarColorId = (typeof AVATAR_PALETTE)[number]["id"];

const PALETTE_HEXES: readonly string[] = AVATAR_PALETTE.map((c) => c.hex);

/** Old shape ids with no twin in the new set (§14.3). */
export const LEGACY_SHAPES = {
  cone: "hex",
  tablet: "slab",
  pill: "bean",
} as const satisfies Record<string, AvatarShape>;

/** Old Tailwind-500 swatches → the nearest new one (brown and grey → Stone). */
export const LEGACY_COLORS = {
  "#a855f7": "#c084fc",
  "#b08968": "#a8a29e",
  "#ef4444": "#f87171",
  "#f97316": "#fb923c",
  "#eab308": "#facc15",
  "#22c55e": "#4ade80",
  "#14b8a6": "#2dd4bf",
  "#3b82f6": "#60a5fa",
  "#ec4899": "#f472b6",
  "#9ca3af": "#a8a29e",
} as const;

/**
 * Not a swatch: the look of a bot with no name yet (empty states, the start
 * page). Rendered through CSS; never stored.
 */
export const NEUTRAL_COLOR = "var(--muted-foreground)";

export interface Look {
  shape: AvatarShape;
  /** A `#rrggbb` swatch, or NEUTRAL_COLOR. */
  color: string;
  accessory: AvatarAccessory;
}

export const NEUTRAL_LOOK: Look = {
  shape: "round",
  color: NEUTRAL_COLOR,
  accessory: "none",
};

const HEX = /^#[\da-f]{6}$/i;

const isShape = (value: string): value is AvatarShape =>
  (AVATAR_SHAPES as readonly string[]).includes(value);

const isAccessory = (value: string): value is AvatarAccessory =>
  (AVATAR_ACCESSORIES as readonly string[]).includes(value);

/** Canvas BotNew's hash, unsigned (`>>> 0`) over UTF-16 units. */
export const nameHash = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1)
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * The look a name gets when nothing was picked. `>>> 4`, not the canvas's
 * `>> 4`: a hash with the high bit set would go negative (§14.4).
 */
export const defaultLook = (name: string): Look => {
  if (name.trim() === "") return NEUTRAL_LOOK;
  const h = nameHash(name);
  return {
    shape: DEFAULT_SHAPES[(h >>> 4) % DEFAULT_SHAPES.length]!,
    color: PALETTE_HEXES[h % PALETTE_HEXES.length]!,
    accessory: "none",
  };
};

/**
 * A colour the app accepts: a palette swatch, or any `#rrggbb` whose accent
 * foreground reaches 4.5:1 (so an existing custom colour survives an edit).
 */
export const isSupportedAvatarColor = (color: string): boolean => {
  const lower = color.toLowerCase();
  if (PALETTE_HEXES.includes(lower)) return true;
  return (
    HEX.test(lower) && contrastRatio(lower, accentForeground(lower)) >= 4.5
  );
};

export interface LookSource {
  name: string;
  avatarShape: string;
  avatarColor: string;
  avatarAccessory?: string | null;
}

/** What a stored bot looks like now; legacy values map at render time. */
export const resolveLook = (bot: LookSource): Look => {
  const fallback = defaultLook(bot.name);
  const legacyShape = (LEGACY_SHAPES as Record<string, AvatarShape>)[
    bot.avatarShape
  ];
  const shape = isShape(bot.avatarShape)
    ? bot.avatarShape
    : (legacyShape ?? fallback.shape);
  const lower = bot.avatarColor.toLowerCase();
  const legacyColor = (LEGACY_COLORS as Record<string, string>)[lower];
  const color =
    legacyColor ??
    (isSupportedAvatarColor(lower)
      ? lower
      : fallback.color === NEUTRAL_COLOR
        ? PALETTE_HEXES[0]!
        : fallback.color);
  const accessory =
    bot.avatarAccessory != null && isAccessory(bot.avatarAccessory)
      ? bot.avatarAccessory
      : "none";
  return { shape, color, accessory };
};

export const accentVars = (look: Look): import("react").CSSProperties =>
  ({
    "--bot-accent": look.color,
    "--bot-accent-foreground": accentForeground(look.color),
  }) as import("react").CSSProperties;
