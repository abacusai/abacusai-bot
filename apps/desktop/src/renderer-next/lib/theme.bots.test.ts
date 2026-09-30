/**
 * R3-T8 (theme half, spec 03 §14.5): accent-filled controls and dots get a
 * 1 px `--muted-foreground` boundary in light theme. From the token values
 * (jsdom has no layout): that border reaches 3:1 against every surface an
 * accent control sits on; in dark theme, where it is transparent, every
 * palette colour is itself ≥ 3:1 against the dark surfaces.
 */
import { describe, expect, it } from "vitest";

import { AVATAR_PALETTE } from "#next/lib/bots/avatar";

import { contrastRatio } from "./theme";

/** vitest processes only tokens.css as CSS (`?raw` is empty here): read the file. */
const { readFileSync } = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");
const appCss = readFileSync("src/renderer-next/styles/app.css", "utf8");

/** The declarations of the first `selector {…}` block in app.css. */
const block = (selector: string): string => {
  const start = appCss.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return appCss.slice(start, appCss.indexOf("}", start));
};

/** An achromatic `oklch(L 0 0)` token as `#rrggbb`. */
const token = (scope: string, name: string): string => {
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) 0 0\\)`).exec(
    block(scope)
  );
  expect(match, `--${name} is an achromatic oklch`).not.toBeNull();
  // OKLab with a = b = 0: every linear channel is L³.
  const linear = Number(match![1]) ** 3;
  const srgb =
    linear <= 0.003_130_8
      ? 12.92 * linear
      : 1.055 * linear ** (1 / 2.4) - 0.055;
  const byte = Math.round(Math.min(1, Math.max(0, srgb)) * 255);
  return `#${byte.toString(16).padStart(2, "0").repeat(3)}`;
};

const SURFACES = ["background", "card", "sidebar", "sidebar-accent", "muted"];

describe("accent outline contrast (§14.5)", () => {
  it("light theme: the --muted-foreground border is ≥ 3:1 on every surface", () => {
    const border = token(":root", "muted-foreground");
    expect(contrastRatio(border, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    for (const surface of SURFACES)
      expect(
        contrastRatio(border, token(":root", surface)),
        surface
      ).toBeGreaterThanOrEqual(3);
  });

  it("light theme: every swatch alone is below 3:1 on white (why the border exists)", () => {
    for (const { hex } of AVATAR_PALETTE)
      expect(contrastRatio(hex, "#ffffff")).toBeLessThan(3);
  });

  it("dark theme: every swatch is ≥ 3:1 on the dark surfaces without a border", () => {
    for (const surface of SURFACES)
      for (const { hex } of AVATAR_PALETTE)
        expect(
          contrastRatio(hex, token(".dark", surface)),
          `${hex} on ${surface}`
        ).toBeGreaterThanOrEqual(3);
  });
});
