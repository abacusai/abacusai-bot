/** R1-T9: the overlay slot lists against the installed registry output and tokens.css. */
import { describe, expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

import {
  NO_DRAG_ONLY_SLOTS,
  NO_DRAG_SELECTOR,
  NON_OCCLUDING_SLOTS,
  OCCLUDER_SLOTS,
  RESERVED_OCCLUDER_SLOTS,
} from "./overlay-slots";

import tokensCss from "../../styles/tokens.css?raw";

const sources = readSourceFiles(
  ["../../ui/*.tsx", "../../components/spotlight/*.tsx"],
  import.meta.dirname
);

const installed = new Set(
  Object.values(sources).flatMap((source) =>
    [...source.matchAll(/data-slot="([a-z-]+)"/g)].map((match) => match[1]!)
  )
);

describe("overlay slots", () => {
  it("(a) every occluder exists in the installed ui/", () => {
    for (const slot of OCCLUDER_SLOTS)
      expect(installed.has(slot), slot).toBe(true);
  });

  it("(b) every installed overlay-like slot is classified exactly once", () => {
    const candidates = [...installed].filter(
      (slot) =>
        /-(content|overlay|popup|viewport)$/.test(slot) || slot === "toast"
    );
    const lists = [
      OCCLUDER_SLOTS,
      NO_DRAG_ONLY_SLOTS,
      NON_OCCLUDING_SLOTS,
    ] as const;
    for (const slot of candidates) {
      const hits = lists.filter((list) =>
        (list as readonly string[]).includes(slot)
      );
      expect(hits.length, slot).toBe(1);
    }
  });

  it("(c) reserved slots are not installed yet", () => {
    for (const slot of RESERVED_OCCLUDER_SLOTS)
      expect(installed.has(slot), slot).toBe(false);
  });

  it("(d) tokens.css's no-drag rule equals NO_DRAG_SELECTOR", () => {
    const css = tokensCss;
    const match =
      /((?:\[data-slot="[a-z-]+"\],?\s*)+)\{\s*app-region: no-drag;/.exec(css);
    expect(css.length, css.slice(0, 200)).toBeGreaterThan(100);
    expect(match).not.toBeNull();
    const selector = match![1]!.replace(/\s+/g, "").replace(/,$/, "");
    expect(selector).toBe(NO_DRAG_SELECTOR);
  });
});
