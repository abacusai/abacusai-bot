import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { useLiveQuery } from "@tanstack/react-db";

import "./chat-appearance.css";

/**
 * Keeps `<html>` in the resolved theme (spec 01 §7.7): the live prefs row,
 * the OS scheme when the pref is `system`, and a held theme scope; plus
 * `data-reduce-motion` from `prefs.motion.reduce`, and the look (Appearance:
 * theme colours, accent, contrast, radius, fonts) as CSS variables.
 */
import { useStore } from "@tanstack/react-store";
import { useEffect } from "react";

import { useCollections } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";

import { lookOf, resolvePrefsLook } from "./look";
import {
  applyBootLook,
  applyLook,
  applyTheme,
  CONTRAST_QUERY,
  DARK_QUERY,
  themeOverride,
} from "./theme";
import { useMediaQuery } from "./use-media-query";

/**
 * Every write of the resolved theme and look to `<html>`, for one prefs row
 * (null: not known yet). A held scope wins; with neither, the boot look (this
 * user's last one) is put back, so a scope released before prefs arrive
 * leaves the document as the boot painted it.
 */
const useDocumentTheme = (row: PrefsRow | null): void => {
  const prefs = row ?? DEFAULT_PREFS;
  const dark = useMediaQuery(DARK_QUERY);
  const high = useMediaQuery(CONTRAST_QUERY);
  const override = useStore(themeOverride, (value) => value);
  const look = lookOf(prefs.appearance);
  const { theme, appearance } = prefs;
  const reduce = prefs.motion.reduce;
  const known = row != null;

  useEffect(() => {
    if (!known && override == null) {
      applyTheme(document, applyBootLook(document, { dark, high }));
      return;
    }
    const source = { theme, appearance };
    const applied = resolvePrefsLook(source, override, { dark, high });
    applyTheme(document, applied.mode);
    // A forced scope is not the user's look: never remembered.
    applyLook(
      document,
      applied,
      lookOf(appearance).translucency,
      override ? undefined : source
    );
  }, [known, theme, appearance, override, dark, high]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduce;
  }, [reduce]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-font-size",
      `${look.textSize}px`
    );
    document.documentElement.dataset.bubbleTint = look.bubbleTint
      ? "on"
      : "off";
  }, [look.textSize, look.bubbleTint]);
};

export const ThemeEffect = (): null => {
  const { data } = useLiveQuery(useCollections().prefs);
  useDocumentTheme(data?.[0] ?? null);
  return null;
};

/** The same, for a screen shown before the app (and its prefs) mount. */
export const BootThemeEffect = (): null => {
  useDocumentTheme(null);
  return null;
};
