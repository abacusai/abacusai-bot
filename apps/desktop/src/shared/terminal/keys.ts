export type TerminalAction =
  | "closeTab"
  | "nextTab"
  | "previousTab"
  | "togglePanel"
  | "new";
export const terminalAction = (
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  platform: "mac" | "windows" | "linux"
): TerminalAction | undefined => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab")
    return event.shiftKey ? "previousTab" : "nextTab";
  const mod =
    platform === "mac"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  if (!mod) return;
  if (key === "b" && event.altKey && !event.shiftKey) return "togglePanel";
  if (event.altKey) return;
  if (key === "w" && event.shiftKey === (platform !== "mac")) return "closeTab";
  if (key === "n" && !event.shiftKey) return "new";
};
