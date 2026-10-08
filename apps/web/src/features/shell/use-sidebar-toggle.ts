/**
 * ⌘B and the title-bar sidebar toggle, one action (spec 01 §7.9). Normally it
 * flips `prefs.sidebar.pinned`, sending only that leaf. Where the width band
 * forces the sidebar to float although the user pinned it (sessions at
 * 800), flipping the preference would change nothing on screen, so it
 * reveals (or hides) the floating sidebar instead, with focus moved into it:
 * the keyboard's way to reach it (Codex impl r1 #7).
 */
import { useLocation } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";

import { useShellWidth } from "./breakpoints";
import { shellLayout } from "./layout";
import { closeFloating, openFloating, shellStore } from "./shell-store";
import { useShellMatch } from "./use-shell-match";

export const useSidebarToggle = (panel: {
  open: boolean;
  sessionOpen: boolean;
}) => {
  const width = useShellWidth();
  const location = useLocation();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const { area } = useShellMatch();
  const floatingOpen = useStore(shellStore, (state) => state.floating.open);
  const input = {
    width,
    area,
    pinned: prefs.sidebar.pinned,
    panelOpen: area === "sessions" ? panel.sessionOpen : panel.open,
    view: (location.search as { view?: string }).view,
  };
  const layout = shellLayout(input);
  const pinCanDock =
    shellLayout({ ...input, pinned: true }).sidebar !== "floating";
  const toggle = (): void => {
    // Forced to float, or a phone: the toggle shows and hides the overlay.
    if (!pinCanDock || layout.band === "xs") {
      if (floatingOpen) closeFloating();
      else openFloating("peek");
      return;
    }
    void updatePrefs({ sidebar: { pinned: !prefs.sidebar.pinned } }).catch(
      () => undefined
    );
  };
  return {
    toggle,
    floating: layout.sidebar === "floating",
    floatingOpen,
  };
};
