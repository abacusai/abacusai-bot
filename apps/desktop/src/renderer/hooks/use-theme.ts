import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import { durableStorage } from "../lib/durable-storage";
import { Theme } from "../types";

const THEME_STORAGE_KEY = "theme";

const systemThemeQuery = (): MediaQueryList =>
  window.matchMedia("(prefers-color-scheme: dark)");

const getSystemTheme = (): "light" | "dark" => {
  return systemThemeQuery().matches ? "dark" : "light";
};

// Subscribed, not read during render: otherwise an OS light/dark flip moves
// the CSS tokens but no `isDark` consumer re-renders.
const subscribeToSystemTheme = (callback: () => void): (() => void) => {
  const query = systemThemeQuery();
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};

let currentTheme: Theme = (() => {
  const stored = durableStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
})();

const listeners = new Set<() => void>();

const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

const getSnapshot = () => currentTheme;

const setSharedTheme = (newTheme: Theme) => {
  if (newTheme === currentTheme) return;
  currentTheme = newTheme;
  listeners.forEach((l) => l());
};

export const useTheme = () => {
  const theme = useSyncExternalStore(subscribe, getSnapshot);
  const systemTheme = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemTheme
  );

  const effectiveTheme = theme === "system" ? systemTheme : theme;
  const isDark = effectiveTheme === "dark";

  // Layout effect: the class must land in the same frame as the render, or
  // switching themes flashes the old one.
  useLayoutEffect(() => {
    document.documentElement.dataset.nativeMaterial = String(
      window.api.platform === "darwin" || window.api.platform === "win32"
    );
    document.documentElement.classList.toggle(
      "dark",
      effectiveTheme === "dark"
    );
    void window.api.setThemeSource(theme);
  }, [effectiveTheme, theme]);

  useEffect(() => {
    durableStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    durableStorage.setItem(THEME_STORAGE_KEY, newTheme);
    setSharedTheme(newTheme);
  };

  const toggleTheme = () => {
    setTheme(currentTheme === "dark" ? "light" : "dark");
  };

  return { theme, effectiveTheme, setTheme, toggleTheme, isDark };
};
