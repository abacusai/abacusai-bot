/**
 * `window.__abacusDev` for the screenshot and acceptance runs (spec 01
 * §10.2), installed only in builds made with VITE_UI_GALLERY=1.
 */
import type { AnyRouter } from "@tanstack/react-router";

import type { Db } from "#next/data/db";
import { transitionTypeSink } from "#next/lib/navigation/transition-types";

import { navigateAndSettle } from "./settle";

interface AbacusDev {
  navigateAndSettle(href: string): Promise<void>;
  setPinned(pinned: boolean): Promise<void>;
  setTheme(theme: "system" | "light" | "dark"): Promise<void>;
  setMotion(reduce: "system" | "on" | "off"): Promise<void>;
  band(): string | undefined;
  /** What the collections hold now, for the live-data acceptance checks. */
  rows(table: string): unknown[];
  syncStatus(table: string): unknown;
  /** Types of the document view transitions started since the last call. */
  navTypes(): string[];
  /**
   * Every route a navigation enters waits `ms` in `beforeLoad` first (0:
   * off), so the navigation shows its pending screen (R1-T11b's slow-loader
   * case). `beforeLoad`, not `loader`: code splitting may replace a loader
   * when its chunk arrives.
   */
  setLoaderDelay(ms: number): void;
  /** Whether this build reads the dev fixture tables instead of main's db.*. */
  fixtures: boolean;
  /** No navigation loading and no view transition running. */
  idle(): boolean;
}

/** Wrap each non-root route's `beforeLoad` once; entering waits `delay.ms`. */
const installLoaderDelay = (router: AnyRouter, delay: { ms: number }): void => {
  for (const [id, route] of Object.entries(
    router.routesById as Record<string, { options: { beforeLoad?: unknown } }>
  )) {
    if (id === "__root__") continue;
    const original = route.options.beforeLoad as
      | ((context: { cause?: string }) => unknown)
      | undefined;
    route.options.beforeLoad = async (context: { cause?: string }) => {
      if (delay.ms > 0 && context.cause === "enter")
        await new Promise((resolve) => setTimeout(resolve, delay.ms));
      return original?.(context);
    };
  }
};

export const installDevHooks = (router: AnyRouter, db: Db): void => {
  const tables = db.collections as unknown as Record<
    string,
    { toArray: unknown[]; utils: { status(): unknown } }
  >;
  const navTypes: string[] = [];
  const delay = { ms: 0 };
  installLoaderDelay(router, delay);
  const dev: AbacusDev = {
    navigateAndSettle: (href) =>
      navigateAndSettle(href, {
        router,
        collections: Object.values(db.collections),
      }),
    setPinned: (pinned) => db.updatePrefs({ sidebar: { pinned } }),
    setTheme: (theme) => db.updatePrefs({ theme }),
    setMotion: (reduce) => db.updatePrefs({ motion: { reduce } }),
    band: () => document.documentElement.dataset.band,
    rows: (table) => [...(tables[table]?.toArray ?? [])],
    syncStatus: (table) => tables[table]?.utils.status() ?? null,
    navTypes: () => navTypes.splice(0),
    setLoaderDelay: (ms) => {
      delay.ms = ms;
    },
    fixtures: import.meta.env.VITE_NEXT_DB_FIXTURES === "1",
    idle: () =>
      router.state.status === "idle" &&
      (document as Document & { activeViewTransition?: unknown })
        .activeViewTransition == null,
  };
  (window as Window & { __abacusDev?: AbacusDev }).__abacusDev = dev;
  const document_ = transitionTypeSink.document;
  transitionTypeSink.document = (type) => {
    navTypes.push(type);
    document_(type);
  };
};
