/**
 * The look's colour engine (Appearance): OKLab maths, the built-in catalog,
 * token derivation and the contrast solver.
 *
 * A theme variant is a colour map. Its seeds (`bg`, `fg`, `accent` and six
 * hues) derive every token by OKLab mixing; keys that name a token (an
 * imported VS Code theme's sidebar, syntax or ANSI colours) replace the
 * derived value before anything is solved. The Default theme is the stock
 * token table (app.css, chat.css, bots.css and the GitHub syntax theme) as
 * hex, so its preview shows exactly what is applied. In standard contrast
 * it is left as shipped (no colour is written; see the shortfalls noted at
 * ACCENT_TOKENS); in high contrast it goes through the solver below.
 *
 * Then every text role is solved against every surface it is painted on
 * (PAIRS) to 4.5:1, or 7:1 in high contrast; fills move away from the text
 * on them; control borders, inputs and charts reach 3:1 (4.5:1 high); focus
 * rings reach 3:1 at the 50% opacity the components draw them with; the
 * selection is solved with the text on it. The one intended exemption is
 * the disabled state: components draw it at reduced opacity, which WCAG
 * exempts from text contrast. When a floor cannot be reached (an imported
 * theme with a light sidebar under dark text, say), the solver takes the
 * best achievable colour and `auditTokens` names the pair.
 */
import type {
  PrefsAppearance,
  PrefsRow,
} from "@abacus-ai/contract/contract/rows";
import { THEME_SYNTAX_CLASSES } from "@abacus-ai/contract/look";

import {
  accentForeground,
  contrastRatio,
  luminance,
  type AppliedLook,
  type ResolvedTheme,
} from "./theme";

export type ThemeColors = Readonly<Record<string, string>>;
export interface LookTheme {
  id: string;
  name: string;
  light?: ThemeColors;
  dark?: ThemeColors;
  /** The variants are the stock token table, not seeds. */
  stock?: true;
}

// ─── colour maths: hex ↔ OKLab, mixing, compositing ───────────────────────

type Vec = [number, number, number];
const rgbOf = (hex: string): Vec => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: readonly number[]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
const toLinear = (c: number) =>
  c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number) =>
  c <= 0.003_130_8 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
const mul = (m: number[], [a, b, c]: Vec): Vec => [
  m[0]! * a + m[1]! * b + m[2]! * c,
  m[3]! * a + m[4]! * b + m[5]! * c,
  m[6]! * a + m[7]! * b + m[8]! * c,
];
const LMS = [
  0.412_221_47, 0.536_332_54, 0.051_445_99, 0.211_903_5, 0.680_699_55,
  0.107_396_96, 0.088_302_46, 0.281_718_84, 0.629_978_7,
];
const LAB = [
  0.210_454_26, 0.793_617_79, -0.004_072_05, 1.977_998_5, -2.428_592_2,
  0.450_593_7, 0.025_904_04, 0.782_771_77, -0.808_675_77,
];
const LAB_INV = [
  1, 0.396_337_78, 0.215_803_76, 1, -0.105_561_35, -0.063_854_17, 1,
  -0.089_484_18, -1.291_485_5,
];
const LMS_INV = [
  4.076_741_66, -3.307_711_59, 0.230_969_93, -1.268_438, 2.609_757_4,
  -0.341_319_4, -0.004_196_09, -0.703_418_61, 1.707_614_7,
];
const toLab = (hex: string): Vec =>
  mul(
    LAB,
    mul(LMS, rgbOf(hex).map((c) => toLinear(c / 255)) as Vec).map(
      Math.cbrt
    ) as Vec
  );
const fromLab = (lab: Vec): string =>
  hexOf(
    mul(LMS_INV, mul(LAB_INV, lab).map((c) => c ** 3) as Vec).map(
      (c) => Math.min(1, Math.max(0, toGamma(c))) * 255
    )
  );

/** `a` moved `t` (0–1) of the way to `b`, in OKLab. */
export const mix = (a: string, b: string, t: number): string => {
  const x = toLab(a);
  const y = toLab(b);
  return fromLab(x.map((v, i) => v + (y[i]! - v) * t) as Vec);
};

/** `fg` at `alpha` painted over `bg`, as a browser composites (sRGB). */
export const over = (fg: string, alpha: number, bg: string): string => {
  const f = rgbOf(fg);
  const b = rgbOf(bg);
  return hexOf(f.map((c, i) => c * alpha + b[i]! * (1 - alpha)));
};

const isDark = (hex: string) => luminance(hex) < 0.179;

// ─── solving ───────────────────────────────────────────────────────────────

/** The lowest ratio of `color` (drawn at `alpha`) against any surface. */
const worst = (color: string, surfaces: string[], alpha = 1): number =>
  Math.min(
    ...surfaces.map((s) =>
      contrastRatio(alpha === 1 ? color : over(color, alpha, s), s)
    )
  );

/**
 * `color`, or the least move of it toward black or white that reaches `min`
 * against every surface (drawn at `alpha`). When neither end reaches it, the
 * end that comes closest: `ratio` then reports the shortfall.
 */
export const solve = (
  color: string,
  surfaces: string[],
  min: number,
  alpha = 1
): { color: string; ratio: number } => {
  const start = worst(color, surfaces, alpha);
  if (start >= min || surfaces.length === 0) return { color, ratio: start };
  let best: { color: string; ratio: number; t: number } | null = null;
  for (const target of ["#000000", "#ffffff"]) {
    const end = worst(target, surfaces, alpha);
    if (end < min) {
      if (best == null || (best.t === 1 && end > best.ratio))
        best = { color: target, ratio: end, t: 1 };
      continue;
    }
    let low = 0;
    let high = 1;
    for (let step = 0; step < 16; step++) {
      const t = (low + high) / 2;
      if (worst(mix(color, target, t), surfaces, alpha) >= min) high = t;
      else low = t;
    }
    const solved = mix(color, target, high);
    const ratio = worst(solved, surfaces, alpha);
    if (best == null || best.t === 1 || high < best.t)
      best = { color: solved, ratio, t: high };
  }
  return best!.ratio > start ? best! : { color, ratio: start };
};

/** `fg` moved until it reads at `min`:1 on `bg` (or as near as it gets). */
export const readable = (fg: string, bg: string, min: number): string =>
  solve(fg, [bg], min).color;

// ─── what is painted on what ───────────────────────────────────────────────

/**
 * `text`: 4.5:1 (7:1 high contrast). `fill`: the text on a filled control;
 * the fill moves. `ui`: control boundaries, 3:1 (4.5:1 high). `focus`: the
 * ring at the 50% opacity it is drawn with, 3:1 (4.5:1 high). `hc`:
 * decorative borders, free in standard contrast, 3:1 in high. Focus stays
 * 3:1 in high contrast: a half-opacity ring cannot reach 4.5:1 on white.
 */
type Kind = "text" | "fill" | "ui" | "focus" | "hc";
const PAGE = ["background", "card", "popover", "muted"];
const CHAT = [
  "chat-surface",
  "chat-surface-2",
  "chat-inset",
  "chat-user-bubble",
];
const ROWS = ["sidebar", "sidebar-accent"];
const STATUS = ["background", "card", "chat-surface", ...ROWS];
const PAIRS: ReadonlyArray<readonly [string, readonly string[], Kind]> = [
  ["foreground", ["background", "muted", ...CHAT], "text"],
  ["card-foreground", ["card"], "text"],
  ["popover-foreground", ["popover"], "text"],
  ["secondary-foreground", ["secondary"], "text"],
  ["accent-foreground", ["accent"], "text"],
  ["sidebar-foreground", ROWS, "text"],
  ["sidebar-accent-foreground", ["sidebar-accent"], "text"],
  [
    "muted-foreground",
    [...PAGE, ...CHAT, "chat-diff-add-bg", "chat-diff-del-bg"],
    "text",
  ],
  // Muted text inside the shell chrome (tokens.css scopes it there).
  ["sidebar-muted-foreground", ROWS, "text"],
  ["accent-text", PAGE, "text"],
  ["destructive", PAGE, "text"],
  ...(
    [
      "chat-status-running",
      "chat-status-attention",
      "chat-status-done",
      "chat-status-muted",
      "bots-attention",
      "bots-running",
      "bots-done",
    ] as const
  ).map((key) => [key, STATUS, "text"] as const),
  ["chat-diff-add-fg", ["chat-diff-add-bg"], "text"],
  ["chat-diff-del-fg", ["chat-diff-del-bg"], "text"],
  ...THEME_SYNTAX_CLASSES.map(
    (name) => [`th-${name}`, ["chat-inset", "chat-surface"], "text"] as const
  ),
  ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14].map(
    (i) => [`term-${i}`, ["background"], "text"] as const
  ),
  ["primary-foreground", ["primary"], "fill"],
  ["sidebar-primary-foreground", ["sidebar-primary"], "fill"],
  ["destructive-foreground", ["destructive"], "fill"],
  ["bots-attention-foreground", ["bots-attention"], "fill"],
  ["selected-text", ["selected-surface"], "fill"],
  ["input", PAGE.slice(0, 3), "ui"],
  ["control-border", PAGE.slice(0, 3), "ui"],
  ...[1, 2, 3, 4, 5].map(
    (i) => [`chart-${i}`, ["background", "card"], "ui"] as const
  ),
  ["ring", PAGE, "focus"],
  ["sidebar-ring", ROWS, "focus"],
  ["border", ["background", "card"], "hc"],
  ["sidebar-border", ["sidebar"], "hc"],
];

const floorOf = (kind: Kind, high: boolean): number =>
  kind === "text" || kind === "fill"
    ? high
      ? 7
      : 4.5
    : kind === "hc"
      ? high
        ? 3
        : 0
      : kind === "ui" && high
        ? 4.5
        : 3;

/** Terminal colours that are the background's own end of the palette. */
const bgLikeAnsi = (dark: boolean) => (dark ? [0] : [7, 15]);

/** Pairs in `tokens` below their floor: `token/surface ratio<floor`. */
export const auditTokens = (
  tokens: Readonly<Record<string, string>>,
  high: boolean
): string[] => {
  const out: string[] = [];
  const check = (fg: string, bg: string, min: number, alpha = 1) => {
    const ratio = contrastRatio(alpha === 1 ? fg : over(fg, alpha, bg), bg);
    return ratio + 1e-9 >= min ? null : ratio;
  };
  for (const [token, surfaces, kind] of PAIRS) {
    const min = floorOf(kind, high);
    const fg = tokens[token];
    if (fg == null || min === 0) continue;
    for (const surface of surfaces) {
      const bg = tokens[surface];
      if (bg == null) continue;
      const ratio = check(fg, bg, min, kind === "focus" ? 0.5 : 1);
      if (ratio != null)
        out.push(`${token}/${surface} ${ratio.toFixed(2)}<${min}`);
    }
  }
  const selection = tokens.selection;
  if (selection && tokens.foreground) {
    const ratio = check(tokens.foreground, selection, floorOf("text", high));
    if (ratio != null) out.push(`foreground/selection ${ratio.toFixed(2)}`);
  }
  return out;
};

/** Every pair in `raw` solved at `high` (see the header). */
const solveTokens = (
  raw: Readonly<Record<string, string>>,
  high: boolean
): Record<string, string> => {
  const t: Record<string, string> = { ...raw };
  const dark = isDark(t.background ?? "#ffffff");
  for (const [token, surfaces, kind] of PAIRS) {
    if (t[token] == null) continue;
    const present = surfaces.flatMap((key) => (t[key] ? [t[key]!] : []));
    if (present.length === 0) continue;
    const min = floorOf(kind, high);
    if (kind === "fill") {
      // The text on a fill is near-black or near-white; the fill moves.
      const fill = surfaces[0]!;
      const text = accentForeground(t[fill]!);
      t[token] = text;
      t[fill] = solve(t[fill]!, [text], min).color;
      continue;
    }
    t[token] = solve(t[token]!, present, min, kind === "focus" ? 0.5 : 1).color;
  }
  // Charts are series: when solving collapsed two of them (a grey ramp
  // whose light end all lands on the 3:1 point), rebuild them as a ramp
  // from that point toward the text colour, each a step apart.
  const charts = [1, 2, 3, 4, 5].map((i) => t[`chart-${i}`]);
  if (charts.every(Boolean) && new Set(charts).size < charts.length) {
    const surfaces = [t.background!, t.card ?? t.background!];
    const start = solve(t.background!, surfaces, floorOf("ui", high)).color;
    for (let i = 1; i <= 5; i++)
      t[`chart-${i}`] = mix(start, t.foreground!, (i - 1) / 5);
  }
  // Terminal colours at the background's end of the palette are exempt.
  for (const i of bgLikeAnsi(dark))
    if (raw[`term-${i}`]) t[`term-${i}`] = raw[`term-${i}`]!;
  // The selection: as much accent as the text on it allows.
  if (raw.selection && t.foreground) {
    const min = floorOf("text", high);
    let alpha = 0.35;
    let selection = mix(t.background!, raw.selection, alpha);
    while (alpha > 0.04 && contrastRatio(t.foreground, selection) < min) {
      alpha -= 0.03;
      selection = mix(t.background!, raw.selection, alpha);
    }
    t.selection = selection;
    t["term-selection"] = selection;
  }
  return t;
};

// ─── the stock table and the seeds ─────────────────────────────────────────

const table = (keys: string, values: string): Record<string, string> => {
  const v = values.split(" ");
  return Object.fromEntries(keys.split(" ").map((key, i) => [key, v[i]!]));
};
const STOCK_KEYS =
  "background foreground card card-foreground popover popover-foreground primary primary-foreground secondary secondary-foreground muted muted-foreground accent accent-foreground destructive border input ring chart-1 chart-2 chart-3 chart-4 chart-5 sidebar sidebar-foreground sidebar-primary sidebar-primary-foreground sidebar-accent sidebar-accent-foreground sidebar-border sidebar-ring control-border selected-surface selected-text chat-surface chat-surface-2 chat-inset chat-status-running chat-status-attention chat-status-done chat-status-muted chat-diff-add-bg chat-diff-add-fg chat-diff-del-bg chat-diff-del-fg chat-user-bubble bots-attention bots-attention-foreground bots-running bots-done";
/** Ghostty's own ANSI palette: the stock terminal. */
export const STOCK_ANSI =
  "#000000 #cd3131 #0dbc79 #e5e510 #2472c8 #bc3fbc #11a8cd #e5e5e5 #666666 #f14c4c #23d18b #f5f543 #3b8eea #d670d6 #29b8db #ffffff".split(
    " "
  );
const stock = (values: string, syntax: string): Record<string, string> => {
  const t = table(STOCK_KEYS, values);
  const th = syntax.split(" ");
  return {
    ...t,
    "accent-text": t.primary!,
    "sidebar-muted-foreground": t["muted-foreground"]!,
    "destructive-foreground": accentForeground(t.destructive!),
    // Code is painted on the chat inset (pre is transparent, chat.css).
    "th-background": t["chat-inset"]!,
    "th-token": t.foreground!,
    ...Object.fromEntries(
      THEME_SYNTAX_CLASSES.map((name, i) => [`th-${name}`, th[i]!])
    ),
    ...Object.fromEntries(STOCK_ANSI.map((color, i) => [`term-${i}`, color])),
  };
};
/**
 * app.css, chat.css and bots.css as hex (alpha borders composited on the
 * background), then the GitHub light/dark syntax colours in
 * THEME_SYNTAX_CLASSES order, as plain constants: the highlight themes are
 * presentation code that loads with the markdown chunk, never at boot.
 * look.test.ts checks both against their sources.
 */
export const STOCK: Readonly<Record<ResolvedTheme, ThemeColors>> = {
  light: stock(
    "#ffffff #0a0a0a #f7f7f7 #0a0a0a #ffffff #0a0a0a #171717 #fafafa #f5f5f5 #171717 #f5f5f5 #636363 #f5f5f5 #171717 #e7000b #e5e5e5 #bebebe #a1a1a1 #d4d4d4 #737373 #525252 #404040 #262626 #fafafa #0a0a0a #171717 #fafafa #f5f5f5 #171717 #e5e5e5 #a1a1a1 #8f8f8f #171717 #fafafa #f5f5f5 #ededed #fafafa #a94700 #a94700 #146d34 #636363 #d8f9dd #00521f #ffe5e3 #9b1e22 #e8e8e8 #a94700 #fafafa #a94700 #146d34",
    "#cf222e #0a7f64 #6e7781 #8250df #953800 #0550ae #116329 #0550ae #0550ae #0550ae #953800 #8250df #1a7f37 #cf222e #57606a #0550ae #0969da #953800 #116329 #8250df"
  ),
  dark: stock(
    "#0a0a0a #fafafa #171717 #fafafa #171717 #fafafa #e5e5e5 #171717 #262626 #fafafa #262626 #a1a1a1 #262626 #fafafa #ff6467 #232323 #2f2f2f #737373 #d4d4d4 #737373 #525252 #404040 #262626 #171717 #fafafa #e5e5e5 #171717 #262626 #fafafa #232323 #737373 #808080 #dedede #121212 #232325 #1b1b1e #111113 #fbbb87 #fbbb87 #99ebaa #9e9e9e #132717 #9ceead #2e1818 #fda1a0 #232325 #fbbb87 #171717 #fbbb87 #99ebaa",
    "#ff7b72 #a5d6ff #8b949e #d2a8ff #ffa657 #79c0ff #7ee787 #79c0ff #79c0ff #79c0ff #ffa657 #d2a8ff #7ee787 #ff7b72 #8b949e #79c0ff #58a6ff #ffa657 #7ee787 #d2a8ff"
  ),
};

const HUES = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
const SEEDS = new Set(["bg", "fg", "accent", ...HUES]);
/** Light and dark hue defaults for themes that only name bg/fg/accent. */
const BASE_HUES = {
  light: "#c4372d #2f7d32 #8f6400 #1f62d0 #a3369e #12737f",
  dark: "#f47067 #6bc46d #d9a73a #6cb6ff #c792ea #4fc1c9",
};
const seeds = (spec: string, mode: ResolvedTheme): ThemeColors => {
  const values = `${spec} ${BASE_HUES[mode]}`.split(" ");
  // Named hues in `spec` (positions 3–8) win over the base ones after them.
  const hues = values.length > 9 ? values.slice(3, 9) : values.slice(3);
  return Object.fromEntries(
    [...SEEDS].map((key, i) => [key, i < 3 ? values[i]! : hues[i - 3]!])
  );
};
const theme = (
  id: string,
  name: string,
  light: string | null,
  dark: string | null
): LookTheme => ({
  id,
  name,
  ...(light ? { light: seeds(light, "light") } : {}),
  ...(dark ? { dark: seeds(dark, "dark") } : {}),
});

/** The built-in catalog. Proper names, not translated. */
export const THEMES: readonly LookTheme[] = [
  { id: "default", name: "Default", ...STOCK, stock: true },
  theme("paper", "Paper", "#fbf8f1 #2b2622 #b5562b", "#1d1a16 #ece4d6 #e0894f"),
  theme("slate", "Slate", "#f7f9fc #1b2433 #2f6fde", "#151b26 #dbe3ef #6ea1ff"),
  theme("grove", "Grove", "#f6faf6 #1d2a22 #2f8a57", "#121a15 #d9e8dd #5fca8a"),
  theme("dusk", "Dusk", "#faf8fd #261f33 #7a4fd6", "#19151f #e4ddf0 #a98bff"),
  theme(
    "solarized",
    "Solarized",
    "#fdf6e3 #586e75 #268bd2 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198",
    "#002b36 #93a1a1 #268bd2 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198"
  ),
  theme("midnight", "Midnight", null, "#000000 #e8e8e8 #4c9aff"),
];

/** The accent swatches, each with a translated name (settings.appearance.colors). */
export const ACCENTS = [
  ["blue", "#2f6fde"],
  ["violet", "#7a4fd6"],
  ["pink", "#d6457a"],
  ["orange", "#d9622b"],
  ["gold", "#b88a00"],
  ["green", "#2f8a57"],
  ["teal", "#12838f"],
] as const;

/** Syntax classes (`--th-*`) → the hue that paints them. */
const SYNTAX: Record<(typeof THEME_SYNTAX_CLASSES)[number], string> = {
  keyword: "magenta",
  string: "green",
  comment: "muted",
  function: "blue",
  type: "yellow",
  property: "cyan",
  tag: "red",
  attr: "yellow",
  literal: "cyan",
  number: "orange",
  variable: "red",
  operator: "cyan",
  inserted: "green",
  deleted: "red",
  meta: "muted",
  heading: "blue",
  link: "accent",
  "code-inline": "accent",
  selector: "green",
  command: "magenta",
};

/** The unsolved tokens of a seed variant, with its token overrides merged in. */
const baseTokens = (
  colors: ThemeColors,
  accentOverride: string | null,
  high: boolean
): Record<string, string> => {
  const bg = colors.bg ?? "#ffffff";
  const dark = isDark(bg);
  const fgSeed = colors.fg ?? (dark ? "#ffffff" : "#000000");
  const tint = (t: number) => mix(bg, fgSeed, t);
  const accent = accentOverride ?? colors.accent ?? fgSeed;
  // A hue the variant does not name (an import without terminal colours)
  // is the built-in palette's, never the text colour: diffs, syntax and
  // the terminal stay coloured.
  const builtIn = BASE_HUES[dark ? "dark" : "light"].split(" ");
  const hue = (key: string) =>
    colors[key] ?? builtIn[(HUES as readonly string[]).indexOf(key)] ?? fgSeed;
  const surface = tint(dark ? 0.1 : 0.05);
  const sidebar = colors.sidebar ?? tint(dark ? 0.045 : 0.025);
  const border = tint(high ? 0.32 : dark ? 0.16 : 0.11);
  const muted = tint(0.62);
  const palette: Record<string, string> = {
    ...colors,
    muted,
    accent,
    orange: mix(hue("yellow"), hue("red"), 0.45),
  };
  const addFg = colors["chat-diff-add-fg"] ?? hue("green");
  const delFg = colors["chat-diff-del-fg"] ?? hue("red");
  const add = colors["chat-diff-add-bg"] ?? mix(bg, addFg, dark ? 0.2 : 0.14);
  const del = colors["chat-diff-del-bg"] ?? mix(bg, delFg, dark ? 0.2 : 0.12);
  const t: Record<string, string> = {
    background: bg,
    foreground: fgSeed,
    card: tint(0.03),
    "card-foreground": fgSeed,
    popover: dark ? tint(0.06) : bg,
    "popover-foreground": fgSeed,
    primary: accent,
    "primary-foreground": fgSeed,
    secondary: surface,
    "secondary-foreground": fgSeed,
    muted: surface,
    "muted-foreground": muted,
    "sidebar-muted-foreground": muted,
    accent: surface,
    "accent-foreground": fgSeed,
    "accent-text": accent,
    destructive: hue("red"),
    "destructive-foreground": fgSeed,
    border,
    input: tint(0.3),
    ring: accent,
    sidebar,
    "sidebar-foreground": fgSeed,
    "sidebar-primary": accent,
    "sidebar-primary-foreground": fgSeed,
    "sidebar-accent": mix(sidebar, fgSeed, dark ? 0.1 : 0.06),
    "sidebar-accent-foreground": fgSeed,
    "sidebar-border": border,
    "sidebar-ring": accent,
    "control-border": tint(0.5),
    "selected-surface": fgSeed,
    "selected-text": bg,
    "chat-surface": surface,
    "chat-surface-2": tint(0.08),
    "chat-inset": tint(0.03),
    "chat-user-bubble": mix(tint(0.08), accent, 0.08),
    "chat-status-running": hue("yellow"),
    "chat-status-attention": hue("yellow"),
    "chat-status-done": hue("green"),
    "chat-status-muted": muted,
    "bots-attention": hue("yellow"),
    "bots-attention-foreground": fgSeed,
    "bots-running": hue("yellow"),
    "bots-done": hue("green"),
    "chat-diff-add-bg": add,
    "chat-diff-add-fg": addFg,
    "chat-diff-del-bg": del,
    "chat-diff-del-fg": delFg,
    "th-token": fgSeed,
    selection: colors.selection ?? accent,
  };
  t["th-background"] = t["chat-inset"]!;
  for (const [name, source] of Object.entries(SYNTAX))
    t[`th-${name}`] = palette[source] ?? fgSeed;
  // Charts by hue, so neighbouring series differ by more than lightness.
  ["accent", "blue", "green", "yellow", "magenta"].forEach((key, i) => {
    t[`chart-${i + 1}`] = palette[key] ?? fgSeed;
  });
  // ANSI 0–15: black, the six hues, white; the bright ones lifted.
  const ansi = [
    dark ? tint(0.25) : fgSeed,
    ...HUES.map(hue),
    tint(dark ? 0.85 : 0.4),
  ];
  ansi.forEach((color, i) => {
    t[`term-${i}`] = color;
    t[`term-${i + 8}`] = mix(color, dark ? "#ffffff" : fgSeed, 0.25);
  });
  // Imported tokens replace the derived ones before anything is solved.
  for (const [key, value] of Object.entries(colors))
    if (!SEEDS.has(key)) t[key] = value;
  return t;
};

/** The stock table, with an accent in place of the neutral primary. */
const stockTokens = (
  table: ThemeColors,
  accent: string | null
): Record<string, string> =>
  accent
    ? {
        ...table,
        primary: accent,
        "accent-text": accent,
        ring: accent,
        "sidebar-primary": accent,
        "sidebar-ring": accent,
      }
    : { ...table };

/**
 * The tokens an accent on Default drives. In standard contrast Default
 * writes these (when an accent is chosen) and nothing else: the stock look
 * is the shipped design, left byte-identical.
 */
const ACCENT_TOKENS = [
  "primary",
  "primary-foreground",
  "accent-text",
  "ring",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-ring",
];

/*
 * Stock Default in standard contrast misses these floors (auditTokens over
 * STOCK at 2026-10-05). They are not corrected here; they belong in the
 * design tokens (app.css, chat.css, the stock terminal palette):
 *
 * light: destructive on card 4.45 and muted 4.38 (< 4.5); th-comment on
 *   chat-inset 4.36 and chat-surface 4.17; ANSI on white: 2 green 2.47,
 *   3 yellow 1.35, 6 cyan 2.80, 9 3.57, 10 1.99, 11 1.17, 12 3.36,
 *   13 2.94, 14 2.34; input on background/card/popover 1.73–1.86 (< 3);
 *   chart-1 1.38–1.48; ring at 50% on background/card/popover/muted
 *   1.49–1.54, sidebar-ring 1.49–1.51.
 * dark: ANSI 1 red 3.85, 4 blue 4.07, 5 magenta 4.31, 8 bright black
 *   3.45; input 1.34–1.48; chart-3 2.29–2.53, chart-4 1.73–1.91, chart-5
 *   1.18–1.31; ring at 50% 1.79–1.88, sidebar-ring 1.79–1.87.
 *
 * In high contrast Default runs through the full solver like every theme.
 * look.test.ts keeps this list honest.
 */

const cache = new WeakMap<object, Map<string, Record<string, string>>>();

/**
 * Every token of a variant, solved. Memoised per variant object and
 * options, so the gallery's previews derive once per change.
 */
export const deriveTokens = (
  colors: ThemeColors,
  options: { high?: boolean; accent?: string | null; stock?: boolean } = {}
): Record<string, string> => {
  const key = `${options.high ? 1 : 0}${options.accent ?? ""}${options.stock ? "s" : ""}`;
  let byOptions = cache.get(colors);
  const hit = byOptions?.get(key);
  if (hit) return hit;
  const high = options.high ?? false;
  const accent = options.accent ?? null;
  const tokens =
    options.stock && !high
      ? {
          ...colors,
          ...(accent
            ? Object.fromEntries(
                Object.entries(
                  solveTokens(stockTokens(colors, accent), false)
                ).filter(([token]) => ACCENT_TOKENS.includes(token))
              )
            : {}),
        }
      : solveTokens(
          options.stock
            ? stockTokens(colors, accent)
            : baseTokens(colors, accent, high),
          high
        );
  if (!byOptions) cache.set(colors, (byOptions = new Map()));
  byOptions.set(key, tokens);
  return tokens;
};

// ─── resolving a look ──────────────────────────────────────────────────────

export type Look = PrefsAppearance;
export const DEFAULT_LOOK: Look = {
  textSize: 14,
  bubbleTint: true,
  palette: "default",
  accent: null,
  contrast: "system",
  radius: "default",
  uiFont: "",
  codeFont: "",
  codeFontSize: 12,
  translucency: true,
  railIconsOnly: false,
  allowTwoTabRows: false,
  custom: null,
};
export const lookOf = (appearance: PrefsRow["appearance"]): Look => ({
  ...DEFAULT_LOOK,
  ...appearance,
});

const usable = (variant: ThemeColors | undefined) =>
  typeof variant?.bg === "string" && /^#[\da-f]{6}$/i.test(variant.bg);

/**
 * The custom theme first, then the catalog; an unknown id, or a custom theme
 * with no usable variant (persisted data the schema would now refuse), is
 * the default.
 */
export const findTheme = (look: Look): LookTheme => {
  if (look.palette === "custom" && look.custom) {
    const { name, light, dark } = look.custom;
    const entry: LookTheme = {
      id: "custom",
      name,
      ...(usable(light) ? { light } : {}),
      ...(usable(dark) ? { dark } : {}),
    };
    if (entry.light || entry.dark) return entry;
  }
  return THEMES.find((entry) => entry.id === look.palette) ?? THEMES[0]!;
};

/** The scheme a theme can show: a one-variant theme forces its own. */
export const themeMode = (
  entry: LookTheme,
  wanted: ResolvedTheme
): ResolvedTheme =>
  entry[wanted] ? wanted : wanted === "dark" ? "light" : "dark";

/** Every token a theme shows in a scheme (what its gallery card paints). */
export const themeTokens = (
  entry: LookTheme,
  wanted: ResolvedTheme,
  options: { high: boolean; accent: string | null }
): Record<string, string> =>
  deriveTokens(entry[themeMode(entry, wanted)]!, {
    ...options,
    stock: entry.stock,
  });

const RADII = { sharp: "0.25rem", round: "0.9rem" } as const;
const FONT_SANS = "'Inter Variable'";
const FONT_MONO =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * The variables and scheme a look gives for `wanted` light or dark. A
 * seeded theme writes every token. Default in standard contrast writes no
 * colour at all (only an accent's tokens when one is chosen), so the stock
 * look stays app.css's; in high contrast it writes what the solver changed.
 */
export const resolveLook = (
  look: Look,
  wanted: ResolvedTheme,
  systemHigh: boolean
): AppliedLook => {
  const entry = findTheme(look);
  const mode = themeMode(entry, wanted);
  const high =
    look.contrast === "high" || (look.contrast === "system" && systemHigh);
  const tokens = themeTokens(entry, mode, { high, accent: look.accent });
  const base = entry.stock ? STOCK[mode] : null;
  const vars: Record<string, string> = Object.fromEntries(
    Object.entries(tokens).filter(([key, value]) => base?.[key] !== value)
  );
  if (look.radius !== "default") vars.radius = RADII[look.radius];
  if (look.uiFont) vars["ui-font-family"] = `"${look.uiFont}", ${FONT_SANS}`;
  if (look.codeFont) {
    vars["chat-font-mono"] = `"${look.codeFont}", ${FONT_MONO}`;
    vars["font-mono"] = vars["chat-font-mono"];
  }
  vars["code-font-size"] = `${look.codeFontSize}px`;
  return { palette: entry.id, mode, forced: mode !== wanted, high, vars };
};

/** A prefs row's look for the OS state given, ready for `applyLook`. */
export const resolvePrefsLook = (
  prefs: Pick<PrefsRow, "theme" | "appearance">,
  override: ResolvedTheme | null,
  media: { dark: boolean; high: boolean }
): AppliedLook =>
  resolveLook(
    lookOf(prefs.appearance),
    override ??
      (prefs.theme === "system"
        ? media.dark
          ? "dark"
          : "light"
        : prefs.theme),
    media.high
  );

/**
 * The notch's tokens. The shape stays hardware black; its text, muted text
 * and controls take the theme's dark variant, solved on black.
 */
export const notchTokens = (applied: AppliedLook): Record<string, string> => {
  const { vars, high } = applied;
  const min = high ? 7 : 4.5;
  const control = vars.secondary ?? "#2a2a2e";
  const fg = solve(
    vars.foreground ?? "#f2f2f3",
    ["#000000", control],
    min
  ).color;
  return {
    "notch-fg": fg,
    "notch-muted": readable(
      vars["muted-foreground"] ?? "#b8b8bd",
      "#000000",
      min
    ),
    "notch-control": control,
  };
};
