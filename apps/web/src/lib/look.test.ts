/** The look's engine: maths, the stock table, derivation and contrast. */
import { THEME_SYNTAX_CLASSES } from "@abacus-ai/contract/look";
import { githubDarkTheme } from "@tanstack/highlight/themes/github-dark";
import { githubLightTheme } from "@tanstack/highlight/themes/github-light";
import { describe, expect, it } from "vitest";

import {
  ACCENTS,
  auditTokens,
  DEFAULT_LOOK,
  deriveTokens,
  findTheme,
  mix,
  notchTokens,
  over,
  resolveLook,
  solve,
  STOCK,
  THEMES,
  themeTokens,
  type Look,
} from "./look";
import { contrastRatio } from "./theme";

const look = (patch: Partial<Look> = {}): Look => ({
  ...DEFAULT_LOOK,
  ...patch,
});

describe("colour maths", () => {
  it("mixes in OKLab and composites like a browser", () => {
    expect(mix("#3366ff", "#ff9900", 0)).toBe("#3366ff");
    expect(mix("#3366ff", "#ff9900", 1)).toBe("#ff9900");
    expect(over("#ffffff", 128 / 255, "#000000")).toBe("#808080");
    expect(over("#336699", 1, "#000000")).toBe("#336699");
  });

  it("moves a colour only as far as the floor needs", () => {
    const solved = solve("#bbbbbb", ["#ffffff"], 4.5);
    expect(solved.ratio).toBeGreaterThanOrEqual(4.5);
    expect(solved.ratio).toBeLessThan(4.7);
    expect(solve("#000000", ["#ffffff"], 4.5).color).toBe("#000000");
  });

  it("reports an unreachable floor and keeps the best it can reach", () => {
    const grey = solve("#888888", ["#888888"], 7);
    expect(grey.color).toBe("#000000");
    expect(grey.ratio).toBeCloseTo(5.92, 1);
    // Light and dark surfaces at once: the better compromise, still short.
    const split = solve("#777777", ["#ffffff", "#000000"], 4.5);
    expect(split.ratio).toBeLessThan(4.5);
    expect(split.ratio).toBeGreaterThanOrEqual(
      Math.min(
        contrastRatio("#777777", "#ffffff"),
        contrastRatio("#777777", "#000000")
      )
    );
  });
});

/**
 * Every pair (lib/look.ts PAIRS: text on each surface it is painted on,
 * fills, control borders, inputs, charts, focus rings, selection, ANSI) ×
 * every built-in × light/dark × standard/high × the theme's accent and all
 * seven swatches.
 */
const cases = THEMES.flatMap((theme) =>
  (["light", "dark"] as const).flatMap((mode) =>
    theme[mode]
      ? // Default in standard contrast is the shipped design, not solved.
        (theme.stock ? [true] : [false, true]).flatMap((high) =>
          [null, ...ACCENTS.map(([, color]) => color)].map(
            (accent) =>
              [
                `${theme.id} ${mode} ${high ? "high" : "standard"} ${accent ?? "theme"}`,
                theme,
                mode,
                high,
                accent,
              ] as const
          )
        )
      : []
  )
);

describe("every built-in pair meets its floor", () => {
  it.each(cases)("%s", (_name, theme, mode, high, accent) => {
    expect(
      auditTokens(themeTokens(theme, mode, { high, accent }), high)
    ).toEqual([]);
  });
});

describe("deriveTokens", () => {
  it("solves imported surfaces before the text on them, at the chosen floor", () => {
    const imported = {
      bg: "#ffffff",
      fg: "#777777",
      popover: "#9a9a9a",
      sidebar: "#f3f3f3",
      "sidebar-foreground": "#dddddd",
      "th-keyword": "#cccccc",
    };
    for (const high of [false, true]) {
      const t = deriveTokens(imported, { high });
      const min = high ? 7 : 4.5;
      expect(
        contrastRatio(t["popover-foreground"]!, t.popover!)
      ).toBeGreaterThanOrEqual(min);
      expect(
        contrastRatio(t["sidebar-foreground"]!, t.sidebar!)
      ).toBeGreaterThanOrEqual(min);
      expect(
        contrastRatio(t["th-keyword"]!, t["chat-inset"]!)
      ).toBeGreaterThanOrEqual(min);
      expect(t.sidebar).toBe("#f3f3f3");
      expect(auditTokens(t, high)).toEqual([]);
    }
  });

  it("names the pairs an import makes impossible and keeps the best colour", () => {
    // Mid-grey popover: no text colour reaches 7:1; black (4.69) is the best.
    const grey = deriveTokens(
      { bg: "#ffffff", fg: "#777777", popover: "#777777" },
      { high: true }
    );
    expect(grey["popover-foreground"]).toBe("#000000");
    expect(auditTokens(grey, true)).toContain(
      "popover-foreground/popover 4.69<7"
    );
    // A light popover in a dark theme: muted text cannot suit both.
    const t = deriveTokens(
      { bg: "#101010", fg: "#eeeeee", popover: "#f0f0f0" },
      { high: true }
    );
    const misses = auditTokens(t, true);
    expect(misses.some((miss) => miss.startsWith("muted-foreground/"))).toBe(
      true
    );
    expect(
      contrastRatio(t["popover-foreground"]!, t.popover!)
    ).toBeGreaterThanOrEqual(7);
  });

  it("keeps the accent fill, the accent text and the focus ring apart", () => {
    const t = deriveTokens(THEMES[1]!.light!, { accent: "#b88a00" });
    expect(t.primary).not.toBe(t["accent-text"]);
    expect(
      contrastRatio(t["accent-text"]!, t.background!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(t["primary-foreground"]!, t.primary!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(over(t.ring!, 0.5, t.background!), t.background!)
    ).toBeGreaterThanOrEqual(3);
    expect(t.selection).toBe(t["term-selection"]);
    expect(contrastRatio(t.foreground!, t.selection!)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("memoises per variant and options", () => {
    const variant = THEMES[2]!.dark!;
    expect(deriveTokens(variant, { high: true })).toBe(
      deriveTokens(variant, { high: true })
    );
    expect(deriveTokens(variant)).not.toBe(
      deriveTokens(variant, { high: true })
    );
  });
});

// The stylesheets' oklch values, as the browser paints them.
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, e: "utf8"): string;
};
const dir = (import.meta as ImportMeta & { dirname: string }).dirname;
const css = [
  "../styles/app.css",
  "../features/chat/chat.css",
  "../features/bots/bots.css",
]
  .map((path) => nodeFs.readFileSync(`${dir}/${path}`, "utf8"))
  .join("\n");
const oklch = (value: string, under?: number[]): number[] => {
  const m =
    /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\)/.exec(
      value
    )!;
  const [l, c, h] = [
    Number(m[1]),
    Number(m[2]),
    (Number(m[3]) * Math.PI) / 180,
  ];
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const lms = [
    l + 0.396_337_78 * a + 0.215_803_76 * b,
    l - 0.105_561_35 * a - 0.063_854_17 * b,
    l - 0.089_484_18 * a - 1.291_485_5 * b,
  ].map((x) => x ** 3);
  const lin = [
    4.076_741_66 * lms[0]! - 3.307_711_59 * lms[1]! + 0.230_969_93 * lms[2]!,
    -1.268_438 * lms[0]! + 2.609_757_4 * lms[1]! - 0.341_319_4 * lms[2]!,
    -0.004_196_09 * lms[0]! - 0.703_418_61 * lms[1]! + 1.707_614_7 * lms[2]!,
  ];
  const rgb = lin.map(
    (x) =>
      Math.min(
        1,
        Math.max(
          0,
          x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
        )
      ) * 255
  );
  const alpha = m[4] ? Number(m[4]) / 100 : 1;
  return rgb.map((x, i) => x * alpha + (under?.[i] ?? 0) * (1 - alpha));
};
const declared = (selector: string, source = css): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = new RegExp(
    `(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`,
    "g"
  );
  for (const block of source.matchAll(re))
    for (const [, key, value] of block[1]!.matchAll(
      /--([\w-]+)\s*:\s*(oklch\([^)]*\))/g
    ))
      out[key!] = value!;
  return out;
};

describe("Default", () => {
  it.each([":root", ".dark"])(
    "status colors exist in global %s styles before lazy features load",
    (selector) => {
      const global = nodeFs.readFileSync(`${dir}/../styles/app.css`, "utf8");
      const vars = declared(selector, global);
      for (const status of ["running", "attention", "done", "muted"])
        expect(vars[`chat-status-${status}`]).toBeDefined();
    }
  );

  it.each([
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const)(
    "the stock %s table is the stylesheets' values",
    (mode, selector) => {
      const vars = declared(selector);
      const bg = oklch(vars.background!);
      const keys = Object.keys(vars);
      expect(keys.length).toBeGreaterThan(40);
      for (const key of keys) {
        const stock = STOCK[mode][key];
        expect(stock, key).toBeDefined();
        const want = oklch(vars[key]!, bg);
        const got = [1, 3, 5].map((i) =>
          Number.parseInt(stock!.slice(i, i + 2), 16)
        );
        got.forEach((channel, i) =>
          expect(Math.abs(channel - want[i]!), key).toBeLessThanOrEqual(1)
        );
      }
    }
  );

  it.each(
    THEMES.filter((theme) => theme.id === "default").flatMap(() =>
      (["light", "dark"] as const).flatMap((mode) =>
        [false, true].flatMap((high) =>
          [null, ACCENTS[2][1]].map((accent) => [mode, high, accent] as const)
        )
      )
    )
  )(
    "its card paints what applying it gives (%s, high %s, accent %s)",
    (mode, high, accent) => {
      const applied = resolveLook(
        look({ accent, contrast: high ? "high" : "standard" }),
        mode,
        false
      );
      const preview = themeTokens(THEMES[0]!, mode, { high, accent });
      // Applied = the stylesheets (STOCK) plus the variables written over them.
      const painted = { ...STOCK[mode], ...applied.vars };
      for (const [key, value] of Object.entries(preview))
        expect(painted[key], key).toBe(value);
    }
  );

  it("writes no colour in standard contrast; an accent writes only its tokens", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(
        Object.keys(resolveLook(look({ accent: null }), mode, false).vars)
      ).toEqual(["code-font-size"]);
      expect(
        themeTokens(THEMES[0]!, mode, { high: false, accent: null })
      ).toEqual(STOCK[mode]);
      const { vars } = resolveLook(
        look({ accent: ACCENTS[0][1] }),
        mode,
        false
      );
      expect(Object.keys(vars).sort()).toEqual(
        expect.arrayContaining(["primary", "accent-text", "ring"])
      );
      for (const key of Object.keys(vars))
        expect(key).toMatch(
          /^(primary|primary-foreground|accent-text|ring|sidebar-primary|sidebar-primary-foreground|sidebar-ring|code-font-size)$/
        );
    }
    // High contrast corrects the stock pairs like any theme.
    const high = resolveLook(look({ contrast: "high" }), "light", false).vars;
    expect(high.ring).toBeDefined();
    expect(high["muted-foreground"]).toBeDefined();
  });

  it.each([
    ["light", githubLightTheme],
    ["dark", githubDarkTheme],
  ] as const)(
    "its %s syntax colours are the GitHub theme's",
    (mode, syntax) => {
      for (const name of THEME_SYNTAX_CLASSES)
        expect(STOCK[mode][`th-${name}`], name).toBe(syntax.tokens[name]);
    }
  );

  it("misses exactly the floors look.ts records for the shipped design", () => {
    expect(auditTokens(STOCK.light, false)).toHaveLength(24);
    expect(auditTokens(STOCK.dark, false)).toHaveLength(19);
  });
});

describe("resolveLook", () => {
  it("forces a one-variant theme's scheme; unknown or unusable themes are Default", () => {
    expect(
      resolveLook(look({ palette: "midnight" }), "light", false)
    ).toMatchObject({
      mode: "dark",
      forced: true,
    });
    expect(findTheme(look({ palette: "gone" })).id).toBe("default");
    expect(findTheme(look({ palette: "custom" })).id).toBe("default");
    expect(
      findTheme(
        look({
          palette: "custom",
          custom: { name: "Broken", dark: {} as never },
        })
      ).id
    ).toBe("default");
    expect(
      findTheme(
        look({
          palette: "custom",
          custom: { name: "Mine", dark: { bg: "#000000" } },
        })
      )
    ).toMatchObject({ id: "custom", name: "Mine" });
  });

  it("follows the OS contrast only for system", () => {
    expect(resolveLook(look(), "light", true).high).toBe(true);
    expect(
      resolveLook(look({ contrast: "standard" }), "light", true).high
    ).toBe(false);
    expect(resolveLook(look({ contrast: "high" }), "light", false).high).toBe(
      true
    );
  });

  it("puts fonts, size and radius in variables", () => {
    const { vars } = resolveLook(
      look({
        uiFont: "Avenir Next",
        codeFont: "Menlo",
        codeFontSize: 14,
        radius: "round",
      }),
      "light",
      false
    );
    expect(vars["ui-font-family"]).toBe(`"Avenir Next", 'Inter Variable'`);
    expect(vars["chat-font-mono"]?.startsWith(`"Menlo", `)).toBe(true);
    expect(vars["font-mono"]).toBe(vars["chat-font-mono"]);
    expect(vars["code-font-size"]).toBe("14px");
    expect(vars.radius).toBe("0.9rem");
  });
});

describe("notchTokens", () => {
  it.each(THEMES.filter((theme) => theme.dark))(
    "$id reads on the black shape",
    (theme) => {
      for (const high of [false, true]) {
        const applied = resolveLook(look({ palette: theme.id }), "dark", high);
        const t = notchTokens(applied);
        const min = high ? 7 : 4.5;
        expect(contrastRatio(t["notch-fg"]!, "#000000")).toBeGreaterThanOrEqual(
          min
        );
        expect(
          contrastRatio(t["notch-fg"]!, t["notch-control"]!)
        ).toBeGreaterThanOrEqual(min);
        expect(
          contrastRatio(t["notch-muted"]!, "#000000")
        ).toBeGreaterThanOrEqual(min);
      }
    }
  );
});

it("defaults to logo purple only on Default, with accessible controls and no large fills", () => {
  for (const mode of ["light", "dark"] as const) {
    const tokens = themeTokens(THEMES[0]!, mode, {
      high: false,
      accent: "default",
    });
    expect(tokens.primary).toBe("#A233FB");
    expect(tokens["accent-text"]).toBe(
      mode === "light" ? "#9f32f7" : "#b267ff"
    );
    expect(tokens.ring).toBe(mode === "light" ? "#471273" : "#cfa5ff");
    expect(
      contrastRatio(tokens.primary!, tokens["primary-foreground"]!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(tokens["accent-text"]!, tokens.card!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(over(tokens.ring!, 0.5, tokens.muted!), tokens.muted!)
    ).toBeGreaterThanOrEqual(3);
    for (const key of [
      "background",
      "card",
      "sidebar",
      "sidebar-accent",
      "chat-user-bubble",
    ]) {
      expect(tokens[key]).toBe(STOCK[mode][key]);
    }
    for (const theme of THEMES.slice(1)) {
      expect(
        themeTokens(theme, mode, { high: false, accent: "default" })
      ).toEqual(themeTokens(theme, mode, { high: false, accent: null }));
    }
  }
});
