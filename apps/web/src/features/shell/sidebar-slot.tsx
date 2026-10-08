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
import { useRouterState } from "@tanstack/react-router";
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
import { isRouteTransitionActive } from "#renderer/lib/navigation/route-transition";

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
    </div>
  );
};

const columnWidth = (mode: SidebarMode): number =>
  mode === "pinned"
    ? SHELL_GEOMETRY.sidebarW
    : mode === "strip"
      ? SHELL_GEOMETRY.sidebarStripW
      : 0;

/** Sheet and drawer curve, the one vaul and LibreChat settle on. */
const PHONE_DRAWER_EASE = [0.32, 0.72, 0, 1] as const;

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
  const routePending = useRouterState({
    select: (state) => state.status === "pending",
  });
  const width = columnWidth(mode);
  const column = useMotionValue(width);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // A route change that pins or unpins the sidebar (Sessions with its
    // panel open ↔ Bots) is the router's document view transition's to
    // animate: the column jumps, so the transition captures the final
    // geometry and its group animations carry the sidebar and the pane
    // together (tokens.css), never this spring reflowing the live pane
    // under the cross-fade. A cold area shows its pending shell first and
    // starts the transition once the route resolves, so the column also
    // jumps while the router is pending; a cached area commits straight
    // into the transition, read from a frame callback (the browser runs
    // those before it captures the new state). Toggles outside a route
    // change keep the spring.
    let controls: ReturnType<typeof animate> | null = null;
    const frame = requestAnimationFrame(() => {
      controls = animate(
        column,
        width,
        motionFor<Transition>(
          motionPref,
          routePending || isRouteTransitionActive()
            ? { duration: 0 }
            : springs.sidebar,
          { duration: 0 }
        )
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      controls?.stop();
    };
  }, [column, width, motionPref, routePending]);

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
        {floatingOpen &&
          rail != null && (
            // A phone's drawer dims what it covers; a tap there closes it.
            <motion.div
              key="floating-scrim"
              aria-hidden
              data-slot="sidebar-scrim"
              className="fixed inset-0 z-30 bg-black/30 dark:bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ duration: motionPref === "reduced" ? 0 : 0.3 }}
              onClick={() => onEscape?.()}
            />
          )}
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
                : // A phone's drawer: full height from the left edge, like a
                  // native navigation drawer.
                  "top-0 bottom-0 left-0 z-40 w-[min(88vw,calc(var(--rail-w)+var(--sidebar-w)))] flex-row rounded-none rounded-r-[24px] border-y-0 border-l-0 pt-[calc(env(safe-area-inset-top)+12px)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-[0_0_48px_rgb(0_0_0/0.25)]"
            )}
            {...(rail == null
              ? {
                  initial: { opacity: 0, x: motionPref === "reduced" ? 0 : -8 },
                  animate: { opacity: 1, x: 0 },
                  exit: { opacity: 0, x: motionPref === "reduced" ? 0 : -8 },
                  transition:
                    motionPref === "reduced"
                      ? reducedTransition
                      : springs.sidebar,
                }
              : {
                  // Slides on the drawer curve; a leftward swipe closes it.
                  initial: { x: motionPref === "reduced" ? 0 : "-100%" },
                  animate: { x: 0 },
                  exit: { x: motionPref === "reduced" ? 0 : "-100%" },
                  transition:
                    motionPref === "reduced"
                      ? reducedTransition
                      : { duration: 0.3, ease: PHONE_DRAWER_EASE },
                  drag: "x" as const,
                  dragDirectionLock: true,
                  dragConstraints: { left: 0, right: 0 },
                  dragElastic: { left: 1, right: 0 },
                  dragSnapToOrigin: true,
                  onDragEnd: (
                    _: unknown,
                    info: { offset: { x: number }; velocity: { x: number } }
                  ) => {
                    if (info.offset.x < -72 || info.velocity.x < -400)
                      onEscape?.();
                  },
                })}
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
            {/* The rail item under the pointer picks the area; a short
                crossfade with a nudge keeps the switch quiet. */}
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={floating.area ?? sidebarId ?? "none"}
                data-area={floating.area ?? sidebarId}
                className="flex min-w-0 flex-1 flex-col"
                initial={{ opacity: 0, x: motionPref === "reduced" ? 0 : 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: motionPref === "reduced" ? 0 : -6 }}
                transition={
                  motionPref === "reduced"
                    ? reducedTransition
                    : { duration: 0.14, ease: [0.2, 0, 0, 1] }
                }
              >
                <SidebarContent sidebarId={floating.area ?? sidebarId} />
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
