/**
 * The sidebar column (spec 01 §7.3). Pinned: in layout, 280 wide. Strip (bots
 * at 800): 88 wide. Floating: out of layout, over the content, which never
 * reflows (canvas `HoverSidebar`); opens on rail hover-intent, closes on
 * pointer leave after a 300 ms grace, Escape or navigation.
 */
import { useStore } from "@tanstack/react-store";
import { AnimatePresence, motion } from "motion/react";
import { ViewTransition, type ViewTransitionClassPerType } from "react";

import {
  reducedTransition,
  springs,
  useMotionPreference,
} from "#next/lib/motion";

import type { ShellArea, SidebarMode } from "./layout";
import {
  cancelCloseFloating,
  openFloating,
  scheduleCloseFloating,
  shellStore,
} from "./shell-store";
import { BotsStrip, SIDEBARS } from "./sidebars";

/** Animated only for typed navigations (spec 01 §6.7); "none" otherwise. */
export const SIDEBAR_VT: ViewTransitionClassPerType = {
  "nav-lateral": "sidebar",
  "settings-in": "sidebar",
  "settings-out": "sidebar",
  default: "none",
};

const SidebarContent = ({
  sidebarId,
}: {
  sidebarId: ShellArea | undefined;
}) => {
  const Sidebar = sidebarId == null ? null : SIDEBARS[sidebarId];
  return (
    <ViewTransition
      key={sidebarId ?? "none"}
      enter={SIDEBAR_VT}
      exit={SIDEBAR_VT}
      default="none"
    >
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        {Sidebar != null && <Sidebar />}
      </div>
    </ViewTransition>
  );
};

export const SidebarSlot = ({
  mode,
  sidebarId,
}: {
  mode: SidebarMode;
  sidebarId: ShellArea | undefined;
}) => {
  const floatingOpen = useStore(shellStore, (state) => state.floating.open);
  const motionPref = useMotionPreference();
  const width = mode === "pinned" ? 280 : mode === "strip" ? 88 : 0;
  const layoutTransition =
    motionPref === "reduced" ? { duration: 0 } : springs.sidebar;

  return (
    <>
      <motion.div
        data-slot="sidebar-slot"
        data-mode={mode}
        className="sidebar-slot bg-sidebar relative h-full shrink-0 overflow-hidden"
        initial={false}
        animate={{ width }}
        transition={layoutTransition}
      >
        <div className="h-full" style={{ width }}>
          {mode === "pinned" && <SidebarContent sidebarId={sidebarId} />}
          {mode === "strip" && <BotsStrip />}
        </div>
      </motion.div>
      <AnimatePresence>
        {mode === "floating" && floatingOpen && (
          <motion.div
            key="floating-sidebar"
            data-slot="sidebar-floating"
            className="border-sidebar-border bg-sidebar fixed top-[calc(var(--toolbar-h)+4px)] bottom-1 left-[calc(var(--rail-w)+4px)] z-30 flex w-(--sidebar-w) flex-col overflow-hidden rounded-(--pane-radius) border pt-2 shadow-[0_24px_64px_rgb(0_0_0/0.18)] dark:shadow-[0_24px_64px_rgb(0_0_0/0.6)]"
            initial={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            transition={
              motionPref === "reduced" ? reducedTransition : springs.sidebar
            }
            onPointerEnter={() => {
              cancelCloseFloating();
              openFloating("hover");
            }}
            onPointerLeave={scheduleCloseFloating}
          >
            <SidebarContent sidebarId={sidebarId} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
