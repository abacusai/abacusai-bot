import { useLiveQuery } from "@tanstack/react-db";
/**
 * Keeps `<html>` in the resolved theme (spec 01 §7.7): the live prefs row,
 * the OS scheme when the pref is `system`, and the gallery's override; plus
 * `data-reduce-motion` from `prefs.motion.reduce`, and the look (Appearance:
 * theme colours, accent, contrast, radius, fonts) as CSS variables.
 */
import { useStore } from "@tanstack/react-store";

import "./chat-appearance.css";

import { useEffect } from "react";

import { useCollections } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";

import { lookOf, resolvePrefsLook } from "./look";
import {
  applyLook,
  applyTheme,
  CONTRAST_QUERY,
  DARK_QUERY,
  themeOverride,
  useMedia,
} from "./theme";

export const ThemeEffect = (): null => {
  const { data } = useLiveQuery(useCollections().prefs);
  const row = data?.[0];
  const prefs = row ?? DEFAULT_PREFS;
  const dark = useMedia(DARK_QUERY);
  const high = useMedia(CONTRAST_QUERY);
  const override = useStore(themeOverride, (value) => value);
  const look = lookOf(prefs.appearance);
  const { theme, appearance } = prefs;
  const reduce = prefs.motion.reduce;
  // Until the row loads (a browser host still starting), the look the boot
  // applied stands: this user's last one, not the default.
  const known = row != null || override != null;

  useEffect(() => {
    if (!known) return;
    const source = { theme, appearance };
    const applied = resolvePrefsLook(source, override, { dark, high });
    applyTheme(document, applied.mode);
    // The gallery's override is not the user's look: never remembered.
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

  return null;
};
