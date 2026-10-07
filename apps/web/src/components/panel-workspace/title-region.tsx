import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
      const tools = visible.filter(
        (target) => target.dataset.workspaceGroup !== "chat"
      );
      const target =
        tools.sort(
          (a, b) =>
            b.getBoundingClientRect().right - a.getBoundingClientRect().right
        )[0] ??
        visible[0] ??
        root;
      const rect = (
        target?.closest(".dv-groupview") ?? target
      )?.getBoundingClientRect();
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
      setRegion((previous) =>
        previous.left === next.left && previous.width === next.width
          ? previous
          : next
      );
      bar.style.setProperty(
        "--workspace-title-start",
        `${next.left - barRect.left}px`
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const mutations = new MutationObserver(schedule);
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
    };
  }, []);
  return (
    <div
      ref={ref}
      data-slot="workspace-title-region"
      className="titlebar-nodrag absolute top-0 flex min-w-0 items-start"
      style={{ left: region.left, width: region.width }}
    >
      {children}
    </div>
  );
};
