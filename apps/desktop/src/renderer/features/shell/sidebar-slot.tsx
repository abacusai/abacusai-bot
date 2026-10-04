/**
 * The sidebar column (spec 01 §7.3). Pinned: in layout, 280 wide. Strip (bots
 * at 800): 88 wide. Floating: out of layout, over the content, which never
 * reflows (canvas `HoverSidebar`); opens on rail hover-intent or, for the
 * keyboard, from the title-bar toggle / ⌘B while floating is forced; closes
 * on pointer leave after a 300 ms grace unless focus is inside, on Escape or
 * on navigation.
 *
 * Widths come from SHELL_GEOMETRY (tokens.css mirrors them). One motion
 * value drives the column; pinned content keeps its 280 px and is clipped,
 * the strip follows the column so it stays centred while it animates
 * (Claude impl r1 #18).
 */
import { useStore } from "@tanstack/react-store";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  type Transition,
} from "motion/react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import {
  motionFor,
  reducedTransition,
  springs,
  useMotionPreference,
} from "#renderer/lib/motion";

import { SidebarCreditsCard } from "./credits-card";
import { useFloatingIntent } from "./floating-intent";
import { SHELL_GEOMETRY } from "./geometry";
import type { ShellArea, SidebarMode } from "./layout";
import { shellStore } from "./shell-store";
import { BotsStrip, NEEDS_YOU, SIDEBARS } from "./sidebars";

const SidebarContent = ({
  sidebarId,
}: {
  sidebarId: ShellArea | undefined;
}) => {
  const Sidebar = sidebarId == null ? null : SIDEBARS[sidebarId];
  const NeedsYou = sidebarId == null ? null : NEEDS_YOU[sidebarId];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {NeedsYou != null && <NeedsYou />}
      {Sidebar != null && <Sidebar />}
      <SidebarCreditsCard />
    </div>
  );
};

const columnWidth = (mode: SidebarMode): number =>
  mode === "pinned"
    ? SHELL_GEOMETRY.sidebarW
    : mode === "strip"
      ? SHELL_GEOMETRY.sidebarStripW
      : 0;

const FOCUSABLE =
  "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

export const SidebarSlot = ({
  mode,
  sidebarId,
  onEscape,
}: {
  mode: SidebarMode;
  sidebarId: ShellArea | undefined;
  onEscape?: () => void;
}) => {
  const floating = useStore(shellStore, (state) => state.floating);
  const motionPref = useMotionPreference();
  const intent = useFloatingIntent();
  const width = columnWidth(mode);
  const column = useMotionValue(width);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controls = animate(
      column,
      width,
      motionFor<Transition>(motionPref, springs.sidebar, { duration: 0 })
    );
    return () => controls.stop();
  }, [column, width, motionPref]);

  const floatingOpen = mode === "floating" && floating.open;
  const peek = floatingOpen && floating.reason === "peek";

  // Opened for the keyboard: focus moves in, and back out when it closes.
  useEffect(() => {
    if (!peek) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      floatingRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [peek]);
  useEffect(() => {
    if (floatingOpen || returnFocus.current == null) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target.isConnected) target.focus();
  }, [floatingOpen]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onEscape?.();
  };

  return (
    <>
      <motion.div
        data-slot="sidebar-slot"
        data-mode={mode}
        className="sidebar-slot relative h-full shrink-0 overflow-hidden"
        style={{ width: column }}
      >
        {mode === "pinned" && (
          <div className="h-full" style={{ width: SHELL_GEOMETRY.sidebarW }}>
            <SidebarContent sidebarId={sidebarId} />
          </div>
        )}
        {mode === "strip" && (
          <motion.div className="h-full" style={{ width: column }}>
            <BotsStrip />
          </motion.div>
        )}
      </motion.div>
      <AnimatePresence>
        {floatingOpen && (
          // Phones: the drawer covers the page; a tap beside it closes it.
          <motion.div
            key="floating-backdrop"
            data-slot="sidebar-backdrop"
            aria-hidden
            className="fixed inset-0 z-20 hidden bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => onEscape?.()}
          />
        )}
        {floatingOpen && (
          <motion.div
            key="floating-sidebar"
            ref={floatingRef}
            data-slot="sidebar-floating"
            data-reason={floating.reason ?? undefined}
            className="border-sidebar-border bg-sidebar fixed top-[calc(var(--toolbar-h)+4px)] bottom-1 left-[calc(var(--rail-w)+4px)] z-30 flex w-(--sidebar-w) flex-col overflow-hidden rounded-(--pane-radius) border pt-2 shadow-[0_24px_64px_rgb(0_0_0/0.18)] dark:shadow-[0_24px_64px_rgb(0_0_0/0.6)]"
            initial={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            transition={
              motionPref === "reduced" ? reducedTransition : springs.sidebar
            }
            onPointerEnter={intent.hold}
            onPointerLeave={(event) => {
              // A finger lifting is not the pointer leaving: phones close it
              // by navigating, the backdrop or Escape.
              if (event.pointerType !== "touch") intent.leave();
            }}
            onFocus={intent.hold}
            onBlur={(event) => {
              // Focus left the sidebar for somewhere else: close after the grace.
              if (
                document.documentElement.dataset.band !== "xs" &&
                !event.currentTarget.contains(event.relatedTarget as Node)
              )
                intent.leave();
            }}
            onKeyDown={onKeyDown}
          >
            <SidebarContent sidebarId={sidebarId} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
