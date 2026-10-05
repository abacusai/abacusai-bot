/**
 * Light, dark, system (spec 01 §7.7). shadcn is `.dark`-class only, so the
 * resolved theme goes on `<html>` as the class plus `color-scheme`, so native
 * controls and scrollbars follow. `data-theme` marks that the renderer has
 * applied a theme (tokens.css paints the pre-boot frame without it).
 */
import { Store } from "@tanstack/react-store";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const resolveTheme = (
  pref: ThemePref,
  systemDark: boolean
): ResolvedTheme =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref;

export const applyTheme = (doc: Document, resolved: ResolvedTheme): void => {
  const root = doc.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = resolved;
};

/**
 * A whole-document override while something needs one theme regardless of
 * the user's (the `/__ui` gallery's `theme=light|dark`). Null: follow prefs.
 */
export const themeOverride = new Store<ResolvedTheme | null>(null);

// WCAG 2 relative luminance and contrast ratio.
const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (match == null) return 0;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    Number.parseInt(part ?? "0", 16)
  ) as [number, number, number];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

const ACCENT_DARK_FOREGROUND = "#171717";
const ACCENT_LIGHT_FOREGROUND = "#fafafa";

/**
 * The text colour for a bot's accent swatch: whichever of near-black and
 * near-white contrasts more (Codex r2 #15).
 */
export const accentForeground = (swatch: string): string =>
  contrastRatio(swatch, ACCENT_DARK_FOREGROUND) >=
  contrastRatio(swatch, ACCENT_LIGHT_FOREGROUND)
    ? ACCENT_DARK_FOREGROUND
    : ACCENT_LIGHT_FOREGROUND;

/** Inline style for a route root that shows a bot (§5.3). */
export const botAccentStyle = (
  swatch: string
): Record<"--bot-accent" | "--bot-accent-foreground", string> => ({
  "--bot-accent": swatch,
  "--bot-accent-foreground": accentForeground(swatch),
});
