import { animate, motion, useMotionValue } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "#renderer/lib/cn";
import { durations, useMotionPreference } from "#renderer/lib/motion";

/** A fixed clip keeps neighbouring tabs still while the full label travels. */
export const TabLabel = ({
  label,
  iconOnly,
}: {
  label: string;
  iconOnly: boolean;
}) => {
  const clip = useRef<HTMLSpanElement>(null);
  const reveal = useRef<HTMLSpanElement>(null);
  const x = useMotionValue(0);
  const preference = useMotionPreference();
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    const element = clip.current;
    const text = reveal.current;
    const tab = element?.closest('[role="tab"]');
    if (!element || !text || !tab) return;
    let pointer = false;
    let focused = false;
    let controls: ReturnType<typeof animate> | undefined;
    const refresh = () => {
      controls?.stop();
      x.set(0);
      const distance = text.scrollWidth - element.clientWidth;
      const running =
        preference !== "reduced" &&
        !iconOnly &&
        distance > 1 &&
        (pointer || focused);
      setActive(running);
      if (running)
        controls = animate(x, [0, -distance], {
          ease: "linear",
          duration: Math.max(1, distance / 32),
          delay: durations.tabTitleDelay / 1000,
          repeat: Infinity,
          repeatType: "reverse",
          repeatDelay: durations.tabTitleDelay / 1000,
        });
    };
    const enter = (event: Event) => {
      pointer =
        (event as PointerEvent).pointerType !== "touch" &&
        window.matchMedia("(hover: hover)").matches;
      refresh();
    };
    const leave = () => {
      pointer = false;
      refresh();
    };
    const focus = () => {
      focused = tab.matches(":focus-visible");
      refresh();
    };
    const blur = () => {
      focused = false;
      refresh();
    };
    tab.addEventListener("pointerenter", enter);
    tab.addEventListener("pointerleave", leave);
    tab.addEventListener("focusin", focus);
    tab.addEventListener("focusout", blur);
    const observer = new ResizeObserver(refresh);
    observer.observe(element);
    observer.observe(text);
    refresh();
    return () => {
      controls?.stop();
      observer.disconnect();
      tab.removeEventListener("pointerenter", enter);
      tab.removeEventListener("pointerleave", leave);
      tab.removeEventListener("focusin", focus);
      tab.removeEventListener("focusout", blur);
      x.set(0);
    };
  }, [label, iconOnly, preference, x]);
  return (
    <span
      ref={clip}
      data-slot="tab-label"
      data-marquee-active={active ? "" : undefined}
      className={cn(
        "relative h-5 min-w-0 flex-1 overflow-hidden text-left",
        iconOnly && "sr-only"
      )}
    >
      <span className="block truncate" style={{ opacity: active ? 0 : 1 }}>
        {label}
      </span>
      <motion.span
        ref={reveal}
        aria-hidden
        data-slot="tab-label-reveal"
        data-label={label}
        className="pointer-events-none absolute inset-y-0 left-0 block w-max whitespace-nowrap"
        style={{ x, opacity: active ? 1 : 0 }}
      />
    </span>
  );
};
