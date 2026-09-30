import { useHotkey } from "@tanstack/react-hotkeys";

import { usePrefs } from "#next/data/db/prefs";
import { toHotkeyPlatform } from "#next/lib/platform";
import { useAppContext } from "#next/lib/use-app-context";

import { APP_ACTIONS, resolveKeymap } from "./actions";
declare module "@tanstack/hotkeys" {
  interface HotkeyMeta {
    actionId?: string;
  }
}
/** Registers an action’s live user binding; null deliberately disables it. */
export const useAppHotkey = (
  actionId: string,
  handler: () => void,
  options: {
    enabled?: boolean;
    context?: "window" | "terminal";
    guardRichText?: boolean;
  } = {}
) => {
  const prefs = usePrefs();
  const { system } = useAppContext();
  const action = APP_ACTIONS.find((a) => a.id === actionId);
  const binding = resolveKeymap(
    prefs.keymap,
    toHotkeyPlatform(system.platform)
  )[options.context ?? "window"][actionId];
  useHotkey(
    (binding ?? "F24") as never,
    (event) => {
      const target = event.target as HTMLElement | null;
      if (
        options.guardRichText &&
        (target?.isContentEditable || target?.closest('[data-hotkeys="text"]'))
      )
        return;
      event.preventDefault();
      handler();
    },
    {
      enabled: binding != null && (options.enabled ?? true),
      ignoreInputs: false,
      meta: { actionId, name: action?.labelKey, description: action?.labelKey },
    }
  );
};
