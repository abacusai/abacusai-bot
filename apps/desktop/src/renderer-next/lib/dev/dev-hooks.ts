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
}

export const installDevHooks = (router: AnyRouter, db: Db): void => {
  const tables = db.collections as unknown as Record<
    string,
    { toArray: unknown[]; utils: { status(): unknown } }
  >;
  const navTypes: string[] = [];
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
  };
  (window as Window & { __abacusDev?: AbacusDev }).__abacusDev = dev;
  const document_ = transitionTypeSink.document;
  transitionTypeSink.document = (type) => {
    navTypes.push(type);
    document_(type);
  };
};
