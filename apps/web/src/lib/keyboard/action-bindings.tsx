import { createContext, type ReactNode } from "react";

import { usePrefs } from "#renderer/data/db/prefs";
import { uiPlatform } from "#renderer/lib/platform";
import { useSystem } from "#renderer/lib/use-app-context";

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
  const system = useSystem();
  const bindings = resolveKeymap(prefs.keymap, uiPlatform(system.platform));
  return (
    <ActionBindingsContext value={bindings.window}>
      <TerminalActionBindingsContext value={bindings.terminal}>
        {children}
      </TerminalActionBindingsContext>
    </ActionBindingsContext>
  );
};
