import type { HotkeyPlatform } from "#renderer/lib/platform";

export interface AppAction {
  id: string;
  labelKey: string;
  defaultBinding: string | null;
  rebindable: boolean;
  owner: "shell" | "chat" | "sessions" | "main";
  scope: "window" | "global";
  terminalDefault?: Partial<Record<HotkeyPlatform, string | null>>;
}
const action = (
  id: string,
  defaultBinding: string | null,
  owner: AppAction["owner"] = "shell",
  rebindable = true
): AppAction => ({
  id,
  defaultBinding,
  owner,
  rebindable,
  scope: "window",
  labelKey: `settings.keyboard.actions.${id}`,
});
export const APP_ACTIONS: readonly AppAction[] = [
  action("command-menu", "Mod+K"),
  {
    ...action("new-in-area", "Mod+N"),
    terminalDefault: { windows: null, linux: null },
  },
  action("new-bot", "Mod+Shift+N"),
  action("toggle-sidebar", "Mod+B"),
  action("toggle-side-panel", "Mod+Alt+B"),
  action("open-settings", "Mod+,"),
  action("new-terminal-tab", "Mod+`", "sessions"),
  {
    ...action("close-tab", "Mod+W", "sessions"),
    terminalDefault: { windows: "Ctrl+Shift+W", linux: "Ctrl+Shift+W" },
  },
  action("next-tab", "Ctrl+Tab", "sessions"),
  action("previous-tab", "Ctrl+Shift+Tab", "sessions"),
  action("stop-run", "Mod+.", "chat"),
  action("send", "Enter", "chat", false),
  {
    ...action("notch-reply", "Mod+Shift+Space", "main", false),
    scope: "global",
  },
];
export type ActionId = string;
/** @public Shared phase-5 integration API. */
export type BindingId = ActionId | `${ActionId}@terminal`;
export const resolveKeymap = (
  overrides: Record<string, string | null> | undefined,
  platform: HotkeyPlatform
) => {
  const window: Record<string, string | null> = {};
  const terminal: Record<string, string | null> = {};
  for (const a of APP_ACTIONS) {
    window[a.id] = Object.hasOwn(overrides ?? {}, a.id)
      ? overrides![a.id]!
      : a.defaultBinding;
    const special = a.terminalDefault?.[platform];
    terminal[a.id] =
      special !== undefined
        ? Object.hasOwn(overrides ?? {}, `${a.id}@terminal`)
          ? overrides![`${a.id}@terminal`]!
          : special
        : window[a.id]!;
  }
  return { window, terminal };
};
export const SYSTEM_BINDINGS = [
  "Mod+Q",
  "Mod+H",
  "Mod+M",
  "Mod+Tab",
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+A",
];
export const TERMINAL_RESERVED = [
  "Ctrl+C",
  "Ctrl+D",
  "Ctrl+R",
  "Ctrl+W",
  "Ctrl+N",
  "Ctrl+Z",
  "Ctrl+L",
];
export const bindingIds = (platform: HotkeyPlatform): string[] =>
  APP_ACTIONS.flatMap((a) =>
    a.terminalDefault?.[platform] !== undefined
      ? [a.id, `${a.id}@terminal`]
      : [a.id]
  );
