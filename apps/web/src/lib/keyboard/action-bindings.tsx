import { createContext, type ReactNode } from "react";

import { usePrefs } from "#renderer/data/db/prefs";
import { toHotkeyPlatform } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

import { resolveKeymap } from "./actions";

export const ActionBindingsContext = createContext<Record<
  string,
  string | null
> | null>(null);

export const TerminalActionBindingsContext = createContext<Record<
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
  );
  return (
    <ActionBindingsContext value={bindings.window}>
      <TerminalActionBindingsContext value={bindings.terminal}>
        {children}
      </TerminalActionBindingsContext>
    </ActionBindingsContext>
  );
};
