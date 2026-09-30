/**
 * `window.__abacusDev` for the screenshot and acceptance runs (spec 01
 * §10.2), installed only in builds made with VITE_UI_GALLERY=1.
 */
import type { AnyRouter } from "@tanstack/react-router";

import type { Collections } from "#next/data/collections";
import { updatePrefs } from "#next/data/collections/prefs";
import { transitionTypeSink } from "#next/lib/navigation/transition-types";

import { navigateAndSettle } from "./settle";

interface AbacusDev {
  navigateAndSettle(href: string): Promise<void>;
  setPinned(pinned: boolean): Promise<void>;
  setTheme(theme: "system" | "light" | "dark"): Promise<void>;
  band(): string | undefined;
}

export const installDevHooks = (
  router: AnyRouter,
  collections: Collections
): void => {
  const dev: AbacusDev = {
    navigateAndSettle: (href) =>
      navigateAndSettle(href, {
        router,
        collections: Object.values(collections),
      }),
    setPinned: (pinned) =>
      updatePrefs(collections, (draft) => {
        draft.sidebar = { ...draft.sidebar, pinned };
      }),
    setTheme: (theme) =>
      updatePrefs(collections, (draft) => {
        draft.theme = theme;
      }),
    band: () => document.documentElement.dataset.band,
  };
  (window as Window & { __abacusDev?: AbacusDev }).__abacusDev = dev;
  // What the router seam adds and sees, for the Electron view-transition test.
  const add = transitionTypeSink.add;
  const observe = transitionTypeSink.observe;
  const log: string[] = [];
  (window as Window & { __abacusNavLog?: string[] }).__abacusNavLog = log;
  transitionTypeSink.add = (type) => {
    log.push(`type:${type}`);
    add(type);
  };
  transitionTypeSink.observe = (kind) => {
    log.push(kind);
    observe(kind);
  };
};
