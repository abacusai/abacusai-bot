/**
 * Keeps `<html>` in the resolved theme (spec 01 §7.7): the live prefs row,
 * the OS scheme when the pref is `system`, and the gallery's override; plus
 * `data-reduce-motion` from `prefs.motion.reduce`.
 */
import { useStore } from "@tanstack/react-store";
import { useEffect, useSyncExternalStore } from "react";

import { usePrefs } from "#next/data/db/prefs";

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
  const prefs = usePrefs();
  const dark = useSystemDark();
  const override = useStore(themeOverride, (value) => value);
  const resolved = override ?? resolveTheme(prefs.theme, dark);
  const reduce = prefs.motion.reduce;

  useEffect(() => {
    applyTheme(document, resolved);
  }, [resolved]);

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
