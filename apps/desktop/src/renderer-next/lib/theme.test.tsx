/** R1-T7: theme resolution, ThemeEffect, the appearance control, accent contrast. */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createDb, DbProvider } from "#next/data/db";
import { fixtureTransport, FixtureDb } from "#next/data/fixture-db/fixture-db";
import { fixturePrefs } from "#next/data/fixture-db/rows";
import { AppearanceTheme } from "#next/features/settings";
import { initI18n } from "#next/lib/i18n";
import { setMediaMatches } from "#next/test-support/media";
import { BOT_AVATAR_COLORS } from "#shared/bots";

import {
  accentForeground,
  contrastRatio,
  resolveTheme,
  themeOverride,
} from "./theme";
import { ThemeEffect } from "./theme-effect";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  themeOverride.setState(() => null);
});

const mount = async (
  prefs = fixturePrefs(),
  children: ReactNode = <ThemeEffect />
) => {
  await initI18n();
  const db = new FixtureDb({ prefs });
  const appDb = createDb(fixtureTransport(db), { retryDelayMs: () => 5 });
  const { collections } = appDb;
  cleanups.push(() => collections.prefs.cleanup());
  await collections.prefs.preload();
  render(<DbProvider value={appDb}>{children}</DbProvider>);
  return { db, collections };
};

const root = () => document.documentElement;

describe("resolveTheme", () => {
  it.each([
    ["system", false, "light"],
    ["system", true, "dark"],
    ["light", true, "light"],
    ["dark", false, "dark"],
  ] as const)("%s with a dark OS=%s is %s", (pref, dark, expected) => {
    expect(resolveTheme(pref, dark)).toBe(expected);
  });
});

describe("ThemeEffect", () => {
  it("applies .dark and color-scheme for an explicit dark pref", async () => {
    await mount(fixturePrefs({ theme: "dark" }));
    await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
    expect(root().style.colorScheme).toBe("dark");
  });

  it("stays light for an explicit light pref whatever the OS says", async () => {
    setMediaMatches({ "(prefers-color-scheme: dark)": true });
    await mount(fixturePrefs({ theme: "light" }));
    await waitFor(() => expect(root().style.colorScheme).toBe("light"));
    expect(root().classList.contains("dark")).toBe(false);
  });

  it("follows the OS live only for system", async () => {
    await mount(fixturePrefs({ theme: "system" }));
    await waitFor(() => expect(root().style.colorScheme).toBe("light"));
    act(() => setMediaMatches({ "(prefers-color-scheme: dark)": true }));
    await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
  });

  it("writes data-reduce-motion from prefs", async () => {
    await mount(fixturePrefs({ motion: { reduce: "on" } }));
    await waitFor(() => expect(root().dataset.reduceMotion).toBe("on"));
  });

  it("lets the gallery override the whole document", async () => {
    await mount(fixturePrefs({ theme: "light" }));
    act(() => themeOverride.setState(() => "dark"));
    await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
  });
});

describe("the appearance control", () => {
  it("writes prefs.theme", async () => {
    const { db } = await mount(
      fixturePrefs({ theme: "system" }),
      <AppearanceTheme />
    );
    fireEvent.click(await screen.findByTestId("theme-dark"));
    await waitFor(() => expect(db.prefs.rows.get("app")?.theme).toBe("dark"));
  });
});

describe("accentForeground", () => {
  it.each(BOT_AVATAR_COLORS.map((swatch) => [swatch]))(
    "%s gets a foreground with at least 4.5:1",
    (swatch) => {
      expect(
        contrastRatio(swatch, accentForeground(swatch))
      ).toBeGreaterThanOrEqual(4.5);
    }
  );
});
