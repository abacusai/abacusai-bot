import { createContext, type ReactNode } from "react";

import { usePrefs } from "#next/data/db/prefs";
import { toHotkeyPlatform } from "#next/lib/platform";
import { useAppContext } from "#next/lib/use-app-context";

import { resolveKeymap } from "./actions";

export const ActionBindingsContext = createContext<Record<
  string,
  string | null
> | null>(null);

/** Supplies action bindings to chord-based consumers during the renderer migration. */
export const ActionBindingsProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const prefs = usePrefs();
  const { system } = useAppContext();
  const bindings = resolveKeymap(
    prefs.keymap,
    toHotkeyPlatform(system.platform)
  ).window;
  return (
    <ActionBindingsContext value={bindings}>{children}</ActionBindingsContext>
  );
};
