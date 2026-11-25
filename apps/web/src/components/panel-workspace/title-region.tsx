import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTabsRailWidthReporter } from "#renderer/components/tabs-rail/placement";

/** Clip title controls to the island they control, independently of tab count. */
export const titleRegion = (
  pane: { left: number; right: number },
  leadingRight: number,
  captionLeft: number
) => {
  const left = Math.max(pane.left, leadingRight);
  const right = Math.max(left, Math.min(pane.right, captionLeft));
  return { left, width: right - left };
};

export const WorkspaceTitleRegion = ({ children }: { children: ReactNode }) => {
  const reportWidth = useTabsRailWidthReporter();
  const report = useEffectEvent((width: number) => reportWidth?.(width));
  const ref = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    const bar = element?.closest<HTMLElement>('[data-slot="topbar"]');
    if (!element || !bar) return;
    let frame = 0;
    const observed = new Set<Element>();
    const observer = new ResizeObserver(() => schedule());
    const measure = () => {
      const root =
        document.querySelector(
          '[data-slot="session-dock"] [data-slot="panel-workspace"]'
        ) ?? document.querySelector('[data-slot="panel-workspace"]');
      const candidates = root
        ? [
            ...root.querySelectorAll<HTMLElement>(
              root.hasAttribute("data-workspace-expanded")
                ? "[data-workspace-group][data-group-active]"
                : '[data-workspace-pane="tools"]'
            ),
          ]
        : [];
      for (const target of [bar, root, ...candidates])
        if (target && !observed.has(target)) {
          observed.add(target);
          observer.observe(target);
        }
      const visible = candidates.filter((target) => {
        const rect = target.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const expanded = root?.hasAttribute("data-workspace-expanded") ?? false;
      // Docked: the strip spans every visible pane (each pane's tabs sit over
      // their own pane). Otherwise it sits over the tools pane.
      const rects = (expanded ? visible : visible.slice(-1)).map((target) =>
        (target.closest(".dv-groupview") ?? target).getBoundingClientRect()
      );
      const rect = rects.length
        ? {
            left: Math.min(...rects.map((r) => r.left)),
            right: Math.max(...rects.map((r) => r.right)),
          }
        : root?.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const leading = bar
        .querySelector('[data-slot="topbar-leading"]')
        ?.getBoundingClientRect();
      const end = Number.parseFloat(getComputedStyle(bar).paddingRight) || 0;
      bar.style.setProperty(
        "--workspace-context-start",
        `${(leading?.right ?? barRect.left) - barRect.left}px`
      );
      const next = titleRegion(
        rect ?? barRect,
        (leading?.right ?? barRect.left) + 8,
        barRect.right - end
      );
      report(next.width);
      // No tools pane on screen: the region would span the whole workspace,
      // over the bar's own controls (the actions, the folded "More", the
      // identity). It is a drag area later in the DOM, and Electron applies
      // app-region in DOM order, so on Windows and macOS those controls
      // would only drag the window. It starts after them. (With tabs in the
      // region, tokens.css already ends the actions before it.)
      let controlsEnd = -Infinity;
      for (
        let before =
          rects.length || element.querySelector('[role="tablist"]')
            ? null
            : element.previousElementSibling;
        before;
        before = before.previousElementSibling
      ) {
        if (!observed.has(before)) {
          observed.add(before);
          observer.observe(before);
        }
        const box = before.getBoundingClientRect();
        if (box.width > 0) controlsEnd = Math.max(controlsEnd, box.right);
      }
      if (controlsEnd + 8 > next.left) {
        const right = next.left + next.width;
        next.left = Math.min(right, controlsEnd + 8);
        next.width = right - next.left;
      }
      // Positioned inside the bar, so relative to its left edge.
      const local = { left: next.left - barRect.left, width: next.width };
      setRegion((previous) =>
        previous.left === local.left && previous.width === local.width
          ? previous
          : local
      );
      bar.style.setProperty(
        "--workspace-title-start",
        `${next.left - barRect.left}px`
      );
      bar.style.setProperty("--workspace-title-left", `${next.left}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Chat streams DOM into this subtree constantly; only the dock's own
    // structure (or its flag attributes) can move the title region.
    const structural =
      '[data-slot="session-dock"],[data-slot="panel-workspace"],.dv-groupview,[data-workspace-group]';
    const touches = (node: Node) =>
      node instanceof Element &&
      (node.matches(structural) || node.querySelector(structural) != null);
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(touches)
        )
      )
        schedule();
    });
    const shell = bar.closest('[data-slot="shell"]');
    if (shell)
      mutations.observe(shell, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-workspace-expanded", "data-group-active"],
      });
    observer.observe(bar);
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      bar.style.removeProperty("--workspace-title-start");
      bar.style.removeProperty("--workspace-context-start");
      bar.style.removeProperty("--workspace-title-left");
    };
  }, []);
  return (
    <div
      ref={ref}
      data-slot="workspace-title-region"
      className="titlebar-drag absolute top-0 flex min-w-0 items-start"
      style={{ left: region.left, width: region.width }}
    >
      {children}
    </div>
  );
};
