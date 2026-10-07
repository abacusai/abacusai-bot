import { useLayoutEffect, type RefObject } from "react";

type Bounds = Pick<DOMRect, "top" | "right" | "bottom" | "left">;
/** Half a gutter only on edges shared with another group. */
export const groupInsets = (group: Bounds, workspace: Bounds) => ({
  top: group.top > workspace.top + 1,
  right: group.right < workspace.right - 1,
  bottom: group.bottom < workspace.bottom - 1,
  left: group.left > workspace.left + 1,
});
export const useGroupInsets = (ref: RefObject<HTMLDivElement | null>) => {
  useLayoutEffect(() => {
    const overlay = ref.current?.closest<HTMLElement>(".dv-render-overlay");
    const root = overlay?.closest<HTMLElement>(".panel-dock");
    if (!overlay || !root) return;
    const measure = () => {
      const rect = overlay.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      for (const [edge, internal] of Object.entries(
        groupInsets(rect, root.getBoundingClientRect())
      ))
        overlay.style.setProperty(
          `--dock-inset-${edge}`,
          internal ? "calc(var(--pane-inset) / 2)" : "0px"
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    observer.observe(root);
    measure();
    return () => observer.disconnect();
  }, [ref]);
};
