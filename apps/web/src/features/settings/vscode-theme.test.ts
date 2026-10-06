import { PREFS_GROUP_ENTRIES } from "@abacus-ai/contract/contract/db";
import {
  THEME_FILE_MAX_BYTES,
  THEME_RULES_MAX,
} from "@abacus-ai/contract/look";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { auditTokens, deriveTokens } from "#renderer/lib/look";

import {
  importVsCodeTheme,
  parseJsonc,
  ThemeImportError,
} from "./vscode-theme";

const THEME = `﻿{
  // A dark theme, as VS Code writes them.
  "name": "Harbor Night",
  "type": "dark",
  "colors": {
    "editor.background": "#1b1f27",
    "editor.foreground": "#c8ccd4",
    "focusBorder": "#5aa2ff",
    "sideBar.background": "#161a21",
    "sideBar.foreground": "#ffffff80", /* half white over the sidebar */
    "editor.selectionBackground": "#5aa2ff40",
    "terminal.ansiRed": "#ef6b73",
    "terminal.ansiBrightRed": "#ff8b92",
    "terminal.ansiGreen": "#8fc97a",
  },
  "tokenColors": [
    null,
    "not a rule",
    { "scope": "comment.line.double-slash", "settings": { "foreground": "#5c6370" } },
    { "scope": ["keyword.control", "storage.type"], "settings": { "foreground": "#c678dd" } },
    { "scope": "keyword.operator", "settings": { "foreground": "#56b6c2" } },
    { "scope": "entity.name, support.function", "settings": { "foreground": "#61afef" } },
    { "scope": "source.ts entity.name.function", "settings": { "foreground": "#e5c07b" } },
    { "scope": "string", "settings": { "fontStyle": "italic" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#d19a66" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#e5a06b" } },
  ],
}`;

const parse = (value: unknown) =>
  v.safeParse(PREFS_GROUP_ENTRIES.appearance.custom, value).success;

describe("parseJsonc", () => {
  it("drops a BOM, comments and trailing commas, never inside strings", () => {
    expect(parseJsonc('﻿{"a": "x // y, ]", /* c */ "b": [1,],}')).toEqual({
      a: "x // y, ]",
      b: [1],
    });
    expect(() => parseJsonc("{")).toThrow(ThemeImportError);
  });
});

describe("importVsCodeTheme", () => {
  const { theme, includeOnly } = importVsCodeTheme(THEME, "harbor.json");
  const colors = theme.dark!;

  it("names and classifies the theme, as prefs accept it", () => {
    expect(theme.name).toBe("Harbor Night");
    expect(theme.light).toBeUndefined();
    expect(includeOnly).toBe(false);
    expect(parse(theme)).toBe(true);
  });

  it("maps workbench colours and composites alpha over what they sit on", () => {
    expect(colors).toMatchObject({
      bg: "#1b1f27",
      fg: "#c8ccd4",
      accent: "#5aa2ff",
      sidebar: "#161a21",
      red: "#ef6b73",
      green: "#8fc97a",
      "term-1": "#ef6b73",
      "term-9": "#ff8b92",
    });
    // Half white over the sidebar #161a21, not mixed in OKLab.
    expect(colors["sidebar-foreground"]).toBe("#8b8d90");
    // 25% blue over the editor background.
    expect(colors.selection).toBe("#2b405d");
  });

  it("maps descendant scopes to their class, most specific first, later rules winning ties", () => {
    expect(colors["th-comment"]).toBe("#5c6370");
    expect(colors["th-keyword"]).toBe("#c678dd");
    expect(colors["th-operator"]).toBe("#56b6c2");
    // `source.ts entity.name.function` colours functions, beating `entity.name`.
    expect(colors["th-function"]).toBe("#e5c07b");
    expect(colors["th-type"]).toBe("#61afef");
    expect(colors["th-number"]).toBe("#e5a06b");
    expect(colors["th-string"]).toBeUndefined();
  });

  it("derives a palette whose every pair reads", () => {
    for (const high of [false, true]) {
      const tokens = deriveTokens(colors, { high });
      expect(tokens.background).toBe("#1b1f27");
      expect(tokens.sidebar).toBe("#161a21");
      expect(auditTokens(tokens, high)).toEqual([]);
    }
  });

  it("colours diff rows without any terminal colours", () => {
    const rgb = (hex: string) =>
      [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const green = (hex: string) => rgb(hex)[1]! > rgb(hex)[0]! + 8;
    const red = (hex: string) => rgb(hex)[0]! > rgb(hex)[1]! + 8;
    // The diff editor's own colours (alpha over the editor background).
    const diff = importVsCodeTheme(`{
      "type": "dark",
      "colors": {
        "editor.background": "#1e1e1e",
        "diffEditor.insertedTextBackground": "#9ccc2c33",
        "diffEditor.removedLineBackground": "#ff000033",
        "gitDecoration.addedResourceForeground": "#81b88b",
        "gitDecoration.deletedResourceForeground": "#c74e39"
      }
    }`).theme.dark!;
    expect(diff["chat-diff-add-bg"]).toBe("#374121");
    expect(diff["chat-diff-del-bg"]).toBe("#4b1818");
    expect(diff["chat-diff-add-fg"]).toBe("#81b88b");
    let tokens = deriveTokens(diff);
    expect(tokens["chat-diff-add-bg"]).toBe("#374121");
    expect(green(tokens["chat-diff-add-fg"]!)).toBe(true);
    expect(red(tokens["chat-diff-del-fg"]!)).toBe(true);
    expect(auditTokens(tokens, false)).toEqual([]);
    // Nothing at all: the built-in hues, never grey.
    for (const type of ["dark", "light"]) {
      const bare = importVsCodeTheme(
        `{"type": "${type}", "colors": {"editor.background": "${type === "dark" ? "#1e1e1e" : "#ffffff"}"}}`
      ).theme;
      tokens = deriveTokens((bare.dark ?? bare.light)!);
      expect(green(tokens["chat-diff-add-bg"]!), type).toBe(true);
      expect(red(tokens["chat-diff-del-bg"]!), type).toBe(true);
      expect(green(tokens["chat-diff-add-fg"]!), type).toBe(true);
      expect(red(tokens["chat-diff-del-fg"]!), type).toBe(true);
    }
  });

  it("composites a transparent editor background over the window", () => {
    const dark = importVsCodeTheme(
      '{"type": "dark", "colors": {"editor.background": "#ffffff80"}}'
    );
    expect(dark.theme.dark?.bg).toBe("#808080");
    const light = importVsCodeTheme(
      '{"type": "light", "colors": {"editor.background": "#00000000"}}',
      "clear.json"
    );
    expect(light.theme).toEqual({ name: "clear", light: { bg: "#ffffff" } });
  });

  it("reads the scheme from the background when the type is missing", () => {
    const light = importVsCodeTheme(
      '{"colors": {"editor.background": "#fafafa"}}',
      "paper.jsonc"
    );
    expect(light.theme).toEqual({ name: "paper", light: { bg: "#fafafa" } });
  });

  it("says when a theme is mostly another file (include)", () => {
    const thin = importVsCodeTheme(
      '{"include": "./base.json", "colors": {"editor.background": "#202020"}}'
    );
    expect(thin.includeOnly).toBe(true);
  });

  it("refuses files that are not colour themes, or too big", () => {
    for (const text of [
      '{"name": "x"}',
      "[]",
      "null",
      '{"colors": {"editor.background": "red"}}',
    ])
      expect(() => importVsCodeTheme(text)).toThrow(
        expect.objectContaining({ code: "not-a-theme" })
      );
    expect(() =>
      importVsCodeTheme(" ".repeat(THEME_FILE_MAX_BYTES + 1))
    ).toThrow(expect.objectContaining({ code: "too-large" }));
    const rules = JSON.stringify({
      colors: { "editor.background": "#000000" },
      tokenColors: Array.from({ length: THEME_RULES_MAX + 1 }, () => ({})),
    });
    expect(() => importVsCodeTheme(rules)).toThrow(
      expect.objectContaining({ code: "too-large" })
    );
  });
});
