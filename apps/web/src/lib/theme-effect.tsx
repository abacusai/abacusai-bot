import { useLiveQuery } from "@tanstack/react-db";
/**
 * Keeps `<html>` in the resolved theme (spec 01 §7.7): the live prefs row,
 * the OS scheme when the pref is `system`, and the gallery's override; plus
 * `data-reduce-motion` from `prefs.motion.reduce`.
 */
import { useStore } from "@tanstack/react-store";

import "./chat-appearance.css";

import { useEffect, useSyncExternalStore } from "react";

import { useCollections } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";

import { applyTheme, DARK_QUERY, resolveTheme, themeOverride } from "./theme";

const subscribeDark = (onChange: () => void): (() => void) => {
  const list = window.matchMedia(DARK_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

const systemDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

const useSystemDark = (): boolean =>
  useSyncExternalStore(subscribeDark, systemDark);

export const ThemeEffect = (): null => {
  const { data } = useLiveQuery(useCollections().prefs);
  const row = data?.[0];
  const prefs = row ?? DEFAULT_PREFS;
  const dark = useSystemDark();
  const override = useStore(themeOverride, (value) => value);
  const resolved = override ?? resolveTheme(prefs.theme, dark);
  const reduce = prefs.motion.reduce;
  // Until the row loads (a browser host still starting), the theme the
  // boot applied stands: this user's last one, not the default.
  const known = row != null || override != null;

  useEffect(() => {
    if (known) applyTheme(document, resolved);
  }, [known, resolved]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduce;
  }, [reduce]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-font-size",
      `${prefs.appearance?.textSize ?? 14}px`
    );
    document.documentElement.dataset.bubbleTint =
      prefs.appearance?.bubbleTint === false ? "off" : "on";
  }, [prefs.appearance]);

  return null;
};
