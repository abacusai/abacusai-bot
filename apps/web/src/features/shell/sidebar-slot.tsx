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
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "#renderer/lib/cn";
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
  rail,
}: {
  mode: SidebarMode;
  sidebarId: ShellArea | undefined;
  onEscape?: () => void;
  /** A phone: the rail is off screen and opens with the sidebar, beside it. */
  rail?: ReactNode;
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
          <motion.div
            key="floating-sidebar"
            ref={floatingRef}
            data-slot="sidebar-floating"
            data-reason={floating.reason ?? undefined}
            className={cn(
              "border-sidebar-border bg-sidebar fixed top-[calc(var(--toolbar-h)+4px)] bottom-1 z-30 flex overflow-hidden rounded-(--pane-radius) border pt-2 shadow-[0_24px_64px_rgb(0_0_0/0.18)] dark:shadow-[0_24px_64px_rgb(0_0_0/0.6)]",
              rail == null
                ? "left-[calc(var(--rail-w)+4px)] w-(--sidebar-w) flex-col"
                : "top-[calc(var(--toolbar-h)+env(safe-area-inset-top)+4px)] bottom-[calc(env(safe-area-inset-bottom)+4px)] left-[calc(env(safe-area-inset-left)+4px)] w-[calc(var(--rail-w)+var(--sidebar-w))] max-w-[calc(100vw-8px)] flex-row"
            )}
            initial={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: motionPref === "reduced" ? 0 : -8 }}
            transition={
              motionPref === "reduced" ? reducedTransition : springs.sidebar
            }
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") intent.hold();
            }}
            onPointerLeave={(event) => {
              // A finger lifting is not leaving; focus leaving still closes it.
              if (event.pointerType === "mouse") intent.leave();
            }}
            onFocus={intent.hold}
            onBlur={(event) => {
              // Focus left the sidebar for somewhere else: close after the grace.
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                intent.leave();
            }}
            onKeyDown={onKeyDown}
          >
            {rail}
            <div className="flex min-w-0 flex-1 flex-col">
              <SidebarContent sidebarId={sidebarId} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
