/**
 * R1-T8: axe-core over the gallery in jsdom (color-contrast and region off:
 * jsdom has no layout; the Electron run checks contrast). Each section with
 * nothing open, then each overlay example alone; a non-modal overlay leaves
 * the rest of the section in the accessibility tree. Run in both gallery
 * themes while the app's own theme is the opposite.
 */
import { act, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import {
  defaultSeed,
  renderApp,
  type AppHarness,
} from "#renderer/test-support/app-harness";

import {
  GALLERY_OVERLAY_IDS,
  GALLERY_SECTIONS,
  OVERLAY_SECTION,
} from "./search";

let harness: AppHarness | null = null;
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const NON_MODAL = new Set([
  "popover",
  "tooltip",
  "hover-card",
  "combobox",
  "drawer",
]);

const audit = async () => {
  const results = await axe.run(document, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
      // Base UI focus guards are intentionally focusable, aria-hidden spans.
      "aria-hidden-focus": { enabled: false },
    },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 3),
  }));
};

const open = async (path: string, appTheme: "light" | "dark") => {
  const seed = defaultSeed();
  seed.prefs = fixturePrefs({ theme: appTheme });
  harness = await renderApp(path, { seed });
  await waitFor(() =>
    expect(document.querySelector('[data-testid="gallery"]')).not.toBeNull()
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
};

describe("gallery a11y", () => {
  it.each(
    GALLERY_SECTIONS.map(
      (section, index) => [section, index % 2 === 0 ? "light" : "dark"] as const
    )
  )("section %s (theme %s) has no violations", async (section, theme) => {
    await open(
      `/__ui?section=${section}&theme=${theme}`,
      theme === "light" ? "dark" : "light"
    );
    expect(document.documentElement.classList.contains("dark")).toBe(
      theme === "dark"
    );
    expect(await audit()).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const)
    it.each(GALLERY_OVERLAY_IDS.map((id) => [id]))(
      `overlay %s alone (theme ${theme}) has no violations`,
      async (id) => {
        await open(
          `/__ui?section=${OVERLAY_SECTION[id]}&theme=${theme}&open=${id}`,
          theme === "light" ? "dark" : "light"
        );
        const section = document.querySelector(
          `[data-gallery-section="${OVERLAY_SECTION[id]}"]`
        )!;
        expect(section).not.toBeNull();
        if (NON_MODAL.has(id)) {
          expect(section.closest("[aria-hidden='true'], [inert]")).toBeNull();
        }
        expect(await audit()).toEqual([]);
      }
    );
});
