import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { placeCard, type Box } from "./geometry";
export { placeCard, waitForAnchor } from "./geometry";
export const Spotlight = ({
  rect,
  children,
  onDismiss,
  busy = false,
  titleId,
  bodyId,
}: {
  rect: Box | null;
  children: ReactNode;
  onDismiss(): void;
  busy?: boolean;
  titleId: string;
  bodyId: string;
}) => {
  const card = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const roots = [...document.body.children].filter(
      (node) =>
        !node.hasAttribute("data-spotlight-portal") && node.tagName !== "SCRIPT"
    ) as HTMLElement[];
    const old = roots.map((root) => root.inert);
    roots.forEach((root) => {
      root.inert = true;
    });
    card.current?.querySelector<HTMLElement>("[data-tour-next]")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
      if (event.key !== "Tab") return;
      const buttons = card.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled),a[href],input:not(:disabled)"
      );
      if (!buttons?.length) {
        event.preventDefault();
        return;
      }
      const first = buttons[0]!;
      const last = buttons[buttons.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      roots.forEach((root, i) => {
        root.inert = old[i]!;
      });
      if (prior?.isConnected) prior.focus();
    };
  }, [onDismiss]);
  useEffect(() => {
    if (!busy)
      card.current?.querySelector<HTMLElement>("[data-tour-next]")?.focus();
  }, [busy, children]);
  const location = placeCard(
    rect,
    { width: 340, height: 240 },
    { width: innerWidth, height: innerHeight }
  );
  return createPortal(
    <div
      data-spotlight-portal
      data-slot="tour-spotlight"
      className="fixed inset-0 z-50"
    >
      <motion.div
        aria-hidden="true"
        style={{
          position: "absolute",
          borderRadius: 14,
          boxShadow: "0 0 0 9999px rgb(0 0 0 / .55), 0 0 0 2px var(--primary)",
        }}
        animate={{
          x: rect ? rect.x - 4 : innerWidth / 2,
          y: rect ? rect.y - 4 : innerHeight / 2,
          width: rect ? rect.width + 8 : 0,
          height: rect ? rect.height + 8 : 0,
        }}
        transition={
          reduced
            ? { duration: 0 }
            : { type: "spring", mass: 1, stiffness: 80, damping: 14 }
        }
      />
      <motion.div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={busy}
        className="bg-popover text-popover-foreground absolute w-[340px] rounded-2xl p-4 shadow-2xl"
        animate={{ x: location.x, y: location.y }}
        transition={
          reduced
            ? { duration: 0 }
            : {
                type: "spring",
                mass: 1,
                stiffness: 80,
                damping: 14,
                delay: 0.04,
              }
        }
      >
        {children}
      </motion.div>
    </div>,
    document.body
  );
};
