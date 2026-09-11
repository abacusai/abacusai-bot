import { type CSSProperties, type JSX } from "react";

/** Keeps full-window gates draggable without placing content under native controls. */
export function WindowDragRegion(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-slot="window-drag-region"
      className="absolute inset-x-0 top-0 z-10 h-(--workspace-topbar-height)"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    />
  );
}
