/** R1-T5: the layout table, every band × area × pinned × panel, at each boundary. */
import { describe, expect, it } from "vitest";

import { bandFor, shellLayout, type ShellArea } from "./layout";

const AREAS: ShellArea[] = [
  "bots",
  "sessions",
  "routines",
  "artifacts",
  "library",
  "settings",
];

describe("bandFor", () => {
  it.each([
    [799, "sm"],
    [800, "sm"],
    [899, "sm"],
    [900, "md"],
    [999, "md"],
    [1000, "lg"],
    [1099, "lg"],
    [1100, "xl"],
    [1280, "xl"],
  ])("%i px is %s", (width, band) => {
    expect(bandFor(width)).toBe(band);
  });
});

describe("shellLayout", () => {
  for (const width of [800, 899, 900, 999, 1000, 1099, 1100, 1280])
    for (const area of AREAS)
      for (const pinned of [true, false])
        for (const panelOpen of [true, false])
          it(`${width} ${area} pinned=${pinned} panel=${panelOpen}`, () => {
            const state = shellLayout({ width, area, pinned, panelOpen });
            const band = bandFor(width);
            expect(state.band).toBe(band);

            let sidebar = pinned ? "pinned" : "floating";
            if (band === "sm" && area === "bots" && pinned) sidebar = "strip";
            if (band === "sm" && area === "sessions") sidebar = "floating";
            expect(state.sidebar).toBe(sidebar);
            expect(state.sidebarOccupied).toBe(
              sidebar === "pinned" ? 280 : sidebar === "strip" ? 88 : 0
            );

            expect(state.sidePanel).toBe(
              panelOpen ? (band === "xl" ? "layout" : "drawer") : null
            );
            expect(state.titleBar.status).toBe(band === "xl" || band === "lg");
            expect(state.titleBar.actionsFolded).toBe(band === "sm");
            expect(state.titleBar.appName).toBe(sidebar === "pinned");
          });

  it("never unpins by itself: growing the window restores the choice", () => {
    expect(
      shellLayout({
        width: 800,
        area: "sessions",
        pinned: true,
        panelOpen: false,
      }).sidebar
    ).toBe("floating");
    expect(
      shellLayout({
        width: 1100,
        area: "sessions",
        pinned: true,
        panelOpen: false,
      }).sidebar
    ).toBe("pinned");
  });
});
