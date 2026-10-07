/**
 * Light, dark, system (spec 01 §7.7). shadcn is `.dark`-class only, so the
 * resolved theme goes on `<html>` as the class plus `color-scheme`, so native
 * controls and scrollbars follow. `data-theme` marks that the renderer has
 * applied a theme (tokens.css paints the pre-boot frame without it).
 *
 * Also the WCAG contrast helpers, and the startup half of the look
 * (Appearance): putting resolved variables on `<html>` and the boot cache
 * that paints them before prefs arrive. The colour engine that resolves a
 * look is lib/look.ts.
 */
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { effectiveScheme } from "@abacus-ai/contract/look";
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
 * The theme a held scope forces on the whole document, newest first; null:
 * follow prefs. Read by ThemeEffect, written only through `holdTheme`.
 */
export const themeOverride = new Store<ResolvedTheme | null>(null);

const held: { theme: ResolvedTheme }[] = [];

/**
 * Forces `theme` on the document until the returned release runs (a setup
 * screen, the gallery, a phone width). Scopes nest: the newest held wins,
 * and releasing one, in any order, leaves the rest as they were.
 */
export const holdTheme = (theme: ResolvedTheme): (() => void) => {
  const scope = { theme };
  held.push(scope);
  themeOverride.setState(() => theme);
  return () => {
    const index = held.indexOf(scope);
    if (index < 0) return;
    held.splice(index, 1);
    themeOverride.setState(() => held.at(-1)?.theme ?? null);
  };
};

// WCAG 2 relative luminance and contrast ratio.
const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const luminance = (hex: string): number => {
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

// ─── startup: applying a resolved look, and the boot cache ─────────────────

/** Fired on `document` after the scheme or the look's variables change. */
export const LOOK_EVENT = "abacus:look";

export const CONTRAST_QUERY = "(prefers-contrast: more)";

/** A look resolved to variables (lib/look.ts `resolveLook`). */
export interface AppliedLook {
  /** The theme shown (an unknown id resolves to `default`). */
  palette: string;
  mode: ResolvedTheme;
  /** The theme has no variant for the wanted scheme and forces `mode`. */
  forced: boolean;
  high: boolean;
  vars: Record<string, string>;
}

let written: string[] = [];

/** Where the boot look is kept: one record, read before prefs arrive. */
export interface LookStore {
  read(): unknown;
  write(value: unknown): void;
}
let store: LookStore | null = null;

/**
 * The boot look's store. The desktop app keeps it in its own window's
 * localStorage (`localLookStore`: one user per profile); the browser in its
 * per-user last-known store, keyed by the host, once the host is
 * identified. Null (the default, and before then): nothing is read or
 * remembered.
 */
export const setLookStore = (next: LookStore | null): void => {
  store = next;
};

const BOOT_KEY = "abacus.look";
export const localLookStore: LookStore = {
  read: () => JSON.parse(localStorage.getItem(BOOT_KEY) ?? "null"),
  write: (value) => localStorage.setItem(BOOT_KEY, JSON.stringify(value)),
};

/**
 * Puts a resolved look on `<html>`: the variables (removing the ones the
 * previous look set and this one does not), `data-contrast`,
 * `data-translucency` and `data-palette`, then fires LOOK_EVENT. With
 * `source`, remembered for the next boot in the current store.
 */
export const applyLook = (
  doc: Document,
  applied: AppliedLook,
  translucency: boolean,
  source?: Pick<PrefsRow, "theme" | "appearance">
): void => {
  const root = doc.documentElement;
  for (const key of written)
    if (!(key in applied.vars)) root.style.removeProperty(`--${key}`);
  for (const [key, value] of Object.entries(applied.vars))
    root.style.setProperty(`--${key}`, value);
  written = Object.keys(applied.vars);
  root.dataset.contrast = applied.high ? "high" : "standard";
  root.dataset.translucency = translucency ? "on" : "off";
  root.dataset.palette = applied.palette;
  doc.dispatchEvent(new Event(LOOK_EVENT));
  if (source == null || store == null) return;
  try {
    store.write({
      v: BOOT_VERSION,
      source: { theme: source.theme, appearance: source.appearance },
      applied,
      translucency,
    } satisfies BootLook);
  } catch {
    // Private mode or blocked storage: the next boot paints the stock look.
  }
};

const BOOT_VERSION = 3;
interface BootLook {
  v: number;
  source: Pick<PrefsRow, "theme" | "appearance">;
  applied: AppliedLook;
  translucency: boolean;
}

/** Variable names and values a cached look may carry (no `;`, `{`, `(`…). */
const VAR_NAME = /^[a-z][\da-z-]{0,47}$/;
const VAR_VALUE = /^[\w\s"'#.,-]{1,300}$/;
const validBoot = (value: unknown): value is BootLook => {
  const boot = value as BootLook | null;
  const applied = boot?.applied;
  return (
    boot?.v === BOOT_VERSION &&
    typeof boot.translucency === "boolean" &&
    ["system", "light", "dark"].includes(boot.source?.theme) &&
    (boot.source.appearance == null ||
      typeof boot.source.appearance === "object") &&
    applied != null &&
    typeof applied.palette === "string" &&
    VAR_NAME.test(applied.palette) &&
    (applied.mode === "light" || applied.mode === "dark") &&
    typeof applied.high === "boolean" &&
    typeof applied.forced === "boolean" &&
    applied.vars != null &&
    typeof applied.vars === "object" &&
    Object.entries(applied.vars).every(
      ([key, val]) =>
        VAR_NAME.test(key) && typeof val === "string" && VAR_VALUE.test(val)
    )
  );
};

/**
 * Before prefs arrive: the scheme and contrast the cached prefs give under
 * today's OS settings (so a one-scheme theme and an explicit mode boot
 * right), and the cached variables when they were resolved for exactly that
 * scheme and contrast. Returns the scheme to boot in.
 */
export const applyBootLook = (
  doc: Document,
  media: { dark: boolean; high: boolean }
): ResolvedTheme => {
  const fallback: ResolvedTheme = media.dark ? "dark" : "light";
  if (store == null) return fallback;
  try {
    const boot = store.read();
    if (!validBoot(boot)) return fallback;
    const { scheme } = effectiveScheme(
      boot.source.theme,
      boot.source.appearance,
      media.dark
    );
    const contrast = boot.source.appearance?.contrast;
    const high = contrast === "high" || (contrast !== "standard" && media.high);
    if (scheme === boot.applied.mode && high === boot.applied.high)
      applyLook(doc, boot.applied, boot.translucency);
    return scheme;
  } catch {
    return fallback;
  }
};
