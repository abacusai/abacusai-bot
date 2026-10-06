import { BOT_AVATAR_COLORS } from "@abacus-ai/contract/bots";
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

import { createDb, DbProvider } from "#renderer/data/db";
import {
  fixtureTransport,
  FixtureDb,
} from "#renderer/data/fixture-db/fixture-db";
import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { initI18n } from "#renderer/lib/i18n";
import { renderApp } from "#renderer/test-support/app-harness";
import { setMediaMatches } from "#renderer/test-support/media";

import { DEFAULT_LOOK, resolveLook, THEMES } from "./look";
import {
  accentForeground,
  applyBootLook,
  applyLook,
  contrastRatio,
  LOOK_EVENT,
  resolveTheme,
  localLookStore,
  setLookStore,
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

  it("puts the chosen theme's tokens on <html> and follows prefs live", async () => {
    const { db } = await mount(
      fixturePrefs({
        theme: "dark",
        appearance: { ...DEFAULT_LOOK, palette: "grove", contrast: "high" },
      })
    );
    await waitFor(() => expect(root().dataset.palette).toBe("grove"));
    expect(root().dataset.contrast).toBe("high");
    expect(root().style.getPropertyValue("--background")).toBe(
      THEMES.find((entry) => entry.id === "grove")!.dark!.bg
    );
    act(() => {
      db.updatePrefs({ appearance: { palette: "midnight" } });
    });
    await waitFor(() => expect(root().dataset.palette).toBe("midnight"));
    act(() => {
      db.updatePrefs({ theme: "light", appearance: { palette: "default" } });
    });
    await waitFor(() => expect(root().dataset.palette).toBe("default"));
    expect(root().style.getPropertyValue("--background")).toBe("");
    expect(root().classList.contains("dark")).toBe(false);
  });

  it("forces a dark-only theme's scheme whatever the pref", async () => {
    await mount(
      fixturePrefs({
        theme: "light",
        appearance: { ...DEFAULT_LOOK, palette: "midnight" },
      })
    );
    await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
  });

  it("lets the gallery override the whole document", async () => {
    await mount(fixturePrefs({ theme: "light" }));
    act(() => themeOverride.setState(() => "dark"));
    await waitFor(() => expect(root().classList.contains("dark")).toBe(true));
  });
});

describe("the appearance control", () => {
  it("writes prefs.theme", async () => {
    const harness = await renderApp("/settings/appearance");
    cleanups.push(async () => {
      harness.view?.unmount();
      await harness.cleanup();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Dark" }));
    await waitFor(() =>
      expect(harness.db.prefs.rows.get("app")?.theme).toBe("dark")
    );
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

describe("the boot look", () => {
  const media = { dark: false, high: false };
  const grove = (theme: "system" | "light" | "dark" = "system") => ({
    theme,
    appearance: { ...DEFAULT_LOOK, palette: "grove" },
  });
  const apply = (source: ReturnType<typeof grove>, dark = false) =>
    applyLook(
      document,
      resolveLook(source.appearance, dark ? "dark" : "light", false),
      true,
      source
    );
  afterEach(() => {
    setLookStore(null);
    localStorage.clear();
    applyLook(document, resolveLook(DEFAULT_LOOK, "light", false), true);
  });

  it("paints the cached look for the scheme the cached prefs give", () => {
    setLookStore(localLookStore);
    apply(grove("dark"), true);
    root().removeAttribute("style");
    // An explicit dark mode boots dark whatever the OS says.
    expect(applyBootLook(document, media)).toBe("dark");
    expect(root().style.getPropertyValue("--background")).toBe(
      THEMES.find((t) => t.id === "grove")!.dark!.bg
    );
  });

  it("skips the variables when the OS changed the scheme or contrast", () => {
    setLookStore(localLookStore);
    apply(grove(), false);
    root().removeAttribute("style");
    expect(applyBootLook(document, { dark: true, high: false })).toBe("dark");
    expect(root().style.getPropertyValue("--background")).toBe("");
    expect(applyBootLook(document, { dark: false, high: true })).toBe("light");
    expect(root().style.getPropertyValue("--background")).toBe("");
  });

  it("boots a one-scheme theme in its own scheme", () => {
    setLookStore(localLookStore);
    const source = {
      theme: "light" as const,
      appearance: { ...DEFAULT_LOOK, palette: "midnight" },
    };
    applyLook(
      document,
      resolveLook(source.appearance, "light", false),
      true,
      source
    );
    expect(applyBootLook(document, media)).toBe("dark");
  });

  it("reads and writes only the store it is given (one per user in the browser)", () => {
    const records = new Map<string, unknown>();
    const user = (id: string) => ({
      read: () => records.get(id) ?? null,
      write: (value: unknown) => records.set(id, value),
    });
    setLookStore(user("a"));
    apply(grove(), false);
    root().removeAttribute("style");
    setLookStore(user("b"));
    applyBootLook(document, media);
    expect(root().style.getPropertyValue("--background")).toBe("");
    setLookStore(user("a"));
    applyBootLook(document, media);
    expect(root().style.getPropertyValue("--background")).not.toBe("");
    setLookStore(null);
    localStorage.clear();
    apply(grove(), false);
    expect(localStorage.getItem("abacus.look")).toBeNull();
    expect(records.size).toBe(1);
  });

  it("refuses an old, malformed or hostile cache", () => {
    setLookStore(localLookStore);
    const write = (value: unknown) =>
      localStorage.setItem("abacus.look", JSON.stringify(value));
    const good = {
      v: 3,
      source: { theme: "light", appearance: DEFAULT_LOOK },
      applied: {
        palette: "grove",
        mode: "light",
        forced: false,
        high: false,
        vars: { background: "#f6faf6" },
      },
      translucency: true,
    };
    for (const bad of [
      { ...good, v: 2 },
      { ...good, applied: { ...good.applied, vars: "x" } },
      { ...good, applied: { ...good.applied, mode: "dim" } },
      {
        ...good,
        applied: { ...good.applied, vars: { background: "red;}body{x" } },
      },
      { ...good, applied: { ...good.applied, vars: { "a b": "#000000" } } },
    ]) {
      write(bad);
      root().removeAttribute("style");
      expect(applyBootLook(document, media)).toBe("light");
      expect(root().style.getPropertyValue("--background")).toBe("");
    }
    localStorage.setItem("abacus.look", "{");
    expect(applyBootLook(document, media)).toBe("light");
    write(good);
    applyBootLook(document, media);
    expect(root().style.getPropertyValue("--background")).toBe("#f6faf6");
  });

  it("tells listeners (the terminal) the look changed", () => {
    let fired = 0;
    const listener = () => fired++;
    document.addEventListener(LOOK_EVENT, listener);
    applyLook(document, resolveLook(DEFAULT_LOOK, "light", false), true);
    document.removeEventListener(LOOK_EVENT, listener);
    expect(fired).toBe(1);
  });
});
