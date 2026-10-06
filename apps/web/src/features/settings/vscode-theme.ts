import type { PrefsAppearance } from "@abacus-ai/contract/contract/rows";
/**
 * A VS Code colour theme (.json, comments, trailing commas and a BOM
 * allowed) as our imported theme: its workbench colours become the seeds
 * lib/look.ts derives from (editor background and text, an accent, the
 * terminal's six hues), plus overrides for the sidebar, borders, overlays,
 * selection, the terminal palette and the syntax colours `tokenColors` give.
 * Only the colours are taken here; the look's solver makes every text role
 * readable on the surfaces it ends up on.
 *
 * Transparent colours are composited over the surface they are painted on
 * (a selection over the editor, sidebar text over the sidebar). A
 * transparent editor background, which VS Code paints over the window, is
 * composited over black for dark themes and white otherwise. `include` is
 * not followed (one file); `includeOnly` says when that left little behind.
 */
import {
  THEME_FILE_MAX_BYTES,
  THEME_RULES_MAX,
  THEME_SYNTAX_CLASSES,
} from "@abacus-ai/contract/look";

import { over } from "#renderer/lib/look";
import { contrastRatio, luminance } from "#renderer/lib/theme";

export class ThemeImportError extends Error {
  constructor(readonly code: "invalid-json" | "not-a-theme" | "too-large") {
    super(code);
  }
}

/** JSONC → JSON: drops a BOM, comments and trailing commas outside strings. */
export const parseJsonc = (text: string): unknown => {
  if (text.length > THEME_FILE_MAX_BYTES)
    throw new ThemeImportError("too-large");
  try {
    return JSON.parse(
      text
        .replace(/^\uFEFF/, "")
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1")
        .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, "$1$2")
    );
  } catch {
    throw new ThemeImportError("invalid-json");
  }
};

/** `#rgb[a]` / `#rrggbb[aa]` → `[#rrggbb, alpha]`. */
const parseHex = (value: unknown): [string, number] | undefined => {
  if (
    typeof value !== "string" ||
    !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
  )
    return;
  const digits =
    value.length < 6 ? value.slice(1).replace(/./g, "$&$&") : value.slice(1);
  const alpha =
    digits.length > 6 ? Number.parseInt(digits.slice(6), 16) / 255 : 1;
  return [`#${digits.slice(0, 6).toLowerCase()}`, alpha];
};

/** A colour composited over the surface it is painted on. */
const hex = (value: unknown, under: string): string | undefined => {
  const parsed = parseHex(value);
  return parsed && over(parsed[0], parsed[1], under);
};

/** Our token ← VS Code keys (first present wins) and what each sits on. */
const WORKBENCH: ReadonlyArray<
  readonly [token: string, keys: readonly string[], on: "bg" | "sidebar"]
> = [
  ["fg", ["editor.foreground", "foreground"], "bg"],
  [
    "accent",
    [
      "focusBorder",
      "button.background",
      "textLink.foreground",
      "activityBarBadge.background",
    ],
    "bg",
  ],
  ["sidebar", ["sideBar.background", "activityBar.background"], "bg"],
  ["sidebar-foreground", ["sideBar.foreground"], "sidebar"],
  ["popover", ["editorWidget.background", "menu.background"], "bg"],
  ["border", ["panel.border", "editorGroup.border", "sideBar.border"], "bg"],
  [
    "selection",
    ["terminal.selectionBackground", "editor.selectionBackground"],
    "bg",
  ],
  // Diff rows: VS Code's diff editor, then its git decorations (the solver
  // then fills what is missing from the terminal's or the built-in hues).
  [
    "chat-diff-add-bg",
    ["diffEditor.insertedTextBackground", "diffEditor.insertedLineBackground"],
    "bg",
  ],
  [
    "chat-diff-del-bg",
    ["diffEditor.removedTextBackground", "diffEditor.removedLineBackground"],
    "bg",
  ],
  ["chat-diff-add-fg", ["gitDecoration.addedResourceForeground"], "bg"],
  ["chat-diff-del-fg", ["gitDecoration.deletedResourceForeground"], "bg"],
];
const ANSI = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
];
const HUES = ["red", "green", "yellow", "blue", "magenta", "cyan"];

/** Our syntax class → the TextMate scope that defines it. */
const SCOPES: Record<(typeof THEME_SYNTAX_CLASSES)[number], string[]> = {
  comment: ["comment"],
  string: ["string"],
  keyword: ["keyword", "storage"],
  function: ["entity.name.function", "support.function"],
  type: [
    "entity.name.type",
    "entity.name.class",
    "support.type",
    "support.class",
  ],
  property: [
    "variable.other.property",
    "support.type.property-name",
    "meta.object-literal.key",
  ],
  tag: ["entity.name.tag"],
  attr: ["entity.other.attribute-name"],
  literal: ["constant.language"],
  number: ["constant.numeric"],
  variable: ["variable"],
  operator: ["keyword.operator"],
  inserted: ["markup.inserted"],
  deleted: ["markup.deleted"],
  meta: ["meta"],
  heading: ["markup.heading"],
  link: ["markup.underline.link"],
  "code-inline": ["markup.inline.raw"],
  selector: ["entity.name.selector", "entity.other.attribute-name.class"],
  command: ["support.function.builtin", "entity.name.command"],
};
const ALL_TARGETS = Object.values(SCOPES).flat();
const depth = (scope: string) => scope.split(".").length;

/**
 * How well one rule scope stands for a target, or -1. Exact beats a
 * descendant (`keyword.control` for `keyword`: the shallower the better),
 * which beats an ancestor (`entity.name` for `entity.name.function`: the
 * deeper the better). A descendant only counts for the target it is
 * closest to, so `keyword.operator.x` is an operator, not a keyword.
 */
const score = (scope: string, target: string): number => {
  if (scope === target) return 3000;
  if (scope.startsWith(`${target}.`)) {
    const closest = ALL_TARGETS.filter(
      (other) => scope === other || scope.startsWith(`${other}.`)
    ).reduce((a, b) => (depth(b) > depth(a) ? b : a));
    return closest === target ? 2000 - depth(scope) : -1;
  }
  if (target.startsWith(`${scope}.`)) return 1000 + depth(scope);
  return -1;
};

type Rule = { scope?: unknown; settings?: { foreground?: unknown } | null };

/**
 * The best rule per class; equal scores go to the later rule, as in VS
 * Code. A selector's last space-separated part names what it colours
 * (`source.js comment` colours comments).
 */
const syntax = (rules: unknown[], under: string): Record<string, string> => {
  const best: Record<string, { score: number; color: string }> = {};
  for (const rule of rules) {
    if (rule == null || typeof rule !== "object") continue;
    const { scope, settings } = rule as Rule;
    const color = hex(settings?.foreground, under);
    if (!color) continue;
    const selectors = Array.isArray(scope)
      ? scope
      : typeof scope === "string"
        ? scope.split(",")
        : [];
    for (const raw of selectors) {
      if (typeof raw !== "string") continue;
      const last = raw.trim().split(/\s+/).at(-1) ?? "";
      if (!last || last.startsWith("-")) continue;
      for (const [name, targets] of Object.entries(SCOPES)) {
        const s = Math.max(...targets.map((target) => score(last, target)));
        if (s >= 0 && s >= (best[name]?.score ?? -1))
          best[name] = { score: s, color };
      }
    }
  }
  return Object.fromEntries(
    Object.entries(best).map(([name, { color }]) => [`th-${name}`, color])
  );
};

export interface ImportedTheme {
  theme: NonNullable<PrefsAppearance["custom"]>;
  /** The file builds on another (`include`) and brought few colours itself. */
  includeOnly: boolean;
}

/** A VS Code theme → the imported theme prefs keep (one variant). */
export const importVsCodeTheme = (
  text: string,
  fileName = ""
): ImportedTheme => {
  const theme = parseJsonc(text) as {
    name?: unknown;
    displayName?: unknown;
    type?: unknown;
    include?: unknown;
    colors?: unknown;
    tokenColors?: unknown;
  } | null;
  if (theme == null || typeof theme !== "object")
    throw new ThemeImportError("not-a-theme");
  const colors =
    theme.colors != null && typeof theme.colors === "object"
      ? (theme.colors as Record<string, unknown>)
      : {};
  const rules = Array.isArray(theme.tokenColors) ? theme.tokenColors : [];
  if (rules.length > THEME_RULES_MAX) throw new ThemeImportError("too-large");
  const type = String(theme.type ?? "");
  const editor = parseHex(colors["editor.background"]);
  if (editor == null) throw new ThemeImportError("not-a-theme");
  const declaredDark = /dark|black/.test(type);
  const declaredLight = !declaredDark && /light/.test(type);
  const window =
    declaredDark || (!declaredLight && luminance(editor[0]) < 0.179)
      ? "#000000"
      : "#ffffff";
  const bg = over(editor[0], editor[1], window);
  const out: Record<string, string> = { bg };
  for (const [token, keys, on] of WORKBENCH) {
    const under = on === "sidebar" ? (out.sidebar ?? bg) : bg;
    const value = keys
      .map((key) => hex(colors[key], under))
      .find((color) => color != null);
    if (value) out[token] = value;
  }
  // An accent the background swallows would leave nothing to see.
  if (out.accent && contrastRatio(out.accent, bg) < 1.5) delete out.accent;
  ANSI.forEach((name, i) => {
    for (const [offset, prefix] of [
      [0, ""],
      [8, "Bright"],
    ] as const) {
      const value = hex(colors[`terminal.ansi${prefix}${name}`], bg);
      if (value) out[`term-${i + offset}`] = value;
    }
    if (i > 0 && i < 7 && out[`term-${i}`])
      out[HUES[i - 1]!] = out[`term-${i}`]!;
  });
  Object.assign(out, syntax(rules, bg));
  const dark = declaredDark || (!declaredLight && luminance(bg) < 0.179);
  const name =
    [theme.displayName, theme.name, fileName.replace(/\.jsonc?$/i, "")]
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim() !== ""
      )
      ?.trim()
      .slice(0, 48) ?? "VS Code";
  return {
    theme: { name, [dark ? "dark" : "light"]: out as { bg: string } },
    includeOnly:
      typeof theme.include === "string" && Object.keys(out).length < 6,
  };
};
