/**
 * The look's shared facts (Appearance): which colour keys a theme variant may
 * carry, the import limits, and which scheme a look actually shows. Main and
 * the renderer both resolve the scheme here, so a theme that exists in one
 * scheme only drives the native theme, vibrancy/mica and the window's
 * pre-paint background as well as the page.
 */
import type { PrefsAppearance, PrefsRow } from "./contract/rows";

export type Scheme = "light" | "dark";

/** A variant's seeds: everything else derives from them (`bg` is required). */
export const THEME_SEED_KEYS = [
  "bg",
  "fg",
  "accent",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
] as const;

/** @tanstack/highlight's syntax classes (`--th-<class>`), bar `token`. */
export const THEME_SYNTAX_CLASSES = [
  "keyword",
  "string",
  "comment",
  "function",
  "type",
  "property",
  "tag",
  "attr",
  "literal",
  "number",
  "variable",
  "operator",
  "inserted",
  "deleted",
  "meta",
  "heading",
  "link",
  "code-inline",
  "selector",
  "command",
] as const;

/**
 * Tokens an imported variant may set directly. Surfaces are taken as given;
 * text colours are starting points the contrast solver still moves.
 */
export const THEME_OVERRIDE_KEYS = [
  "sidebar",
  "sidebar-foreground",
  "popover",
  "card",
  "border",
  "selection",
  "chat-diff-add-bg",
  "chat-diff-add-fg",
  "chat-diff-del-bg",
  "chat-diff-del-fg",
  ...Array.from({ length: 16 }, (_, i) => `term-${i}`),
  ...THEME_SYNTAX_CLASSES.map((name) => `th-${name}`),
] as const;

export const THEME_COLOR_KEYS: readonly string[] = [
  ...THEME_SEED_KEYS,
  ...THEME_OVERRIDE_KEYS,
];

/** Largest theme file or paste the importer reads. */
export const THEME_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Most `tokenColors` rules the importer scans. */
export const THEME_RULES_MAX = 20_000;

/** Built-in themes that exist in one scheme only (the catalog agrees). */
export const SINGLE_SCHEME_THEMES: Readonly<Record<string, Scheme>> = {
  midnight: "dark",
};

/** The schemes a look's theme can show; never empty (unusable → both). */
export const lookSchemes = (
  appearance: Pick<PrefsAppearance, "palette" | "custom"> | undefined
): readonly Scheme[] => {
  if (appearance?.palette === "custom") {
    const custom = appearance.custom;
    const usable = (["light", "dark"] as const).filter(
      (scheme) => typeof custom?.[scheme]?.bg === "string"
    );
    // No usable variant renders the default theme, which has both.
    if (usable.length > 0) return usable;
  }
  const single = SINGLE_SCHEME_THEMES[appearance?.palette ?? ""];
  return single ? [single] : ["light", "dark"];
};

/** What the page shows for a scheme preference; `forced` when the theme overrides it. */
export const effectiveScheme = (
  theme: PrefsRow["theme"],
  appearance: PrefsRow["appearance"],
  systemDark: boolean
): { scheme: Scheme; forced: boolean } => {
  const wanted: Scheme =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const schemes = lookSchemes(appearance);
  return schemes.includes(wanted)
    ? { scheme: wanted, forced: false }
    : { scheme: schemes[0]!, forced: true };
};

/**
 * Electron's `nativeTheme.themeSource` for a prefs row: the stored mode, or
 * the only scheme a one-scheme theme has.
 */
export const nativeThemeSource = (
  row: Pick<PrefsRow, "theme" | "appearance">
): PrefsRow["theme"] => {
  const schemes = lookSchemes(row.appearance);
  return schemes.length === 1 ? schemes[0]! : row.theme;
};
