export const sessionLayout = (
  width: number,
  view: string | undefined,
  tab: string | undefined,
  pinned: boolean
) => ({
  split: width >= 1100 && view !== "full" && tab != null,
  sidebar:
    width < 900 || (width >= 1100 && view !== "full" && tab != null)
      ? "floating"
      : pinned
        ? "pinned"
        : "floating",
  chatFirst: tab != null && (width < 1100 || view === "full"),
  closed: tab == null,
});
export const clampChatWidth = (
  stored: number,
  groupWidth: number,
  dockMinimum: number
): number =>
  Math.max(0, Math.min(Math.max(360, stored), groupWidth - dockMinimum));
