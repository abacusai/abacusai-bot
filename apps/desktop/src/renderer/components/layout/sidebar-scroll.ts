import { useEffect, useRef } from "react";

/** Marks the element a section's rows scroll inside. */
export const SIDEBAR_SCROLLER_ATTR = "data-sidebar-scroller";

/**
 * Centers a row in its own section's scroller only. `scrollIntoView` walks
 * every scrollable ancestor and would shove the whole sidebar column too.
 */
export const scrollRowIntoSection = (
  scroller: HTMLElement,
  row: HTMLElement
): void => {
  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const rowTop = rowRect.top - scrollerRect.top + scroller.scrollTop;
  const rowBottom = rowTop + rowRect.height;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (rowTop >= viewTop && rowBottom <= viewBottom) return;
  scroller.scrollTop = Math.max(
    0,
    rowTop - (scroller.clientHeight - rowRect.height) / 2
  );
};

/** Keeps the active row on screen on mount and whenever the selection moves. */
export const useScrollIntoSection = <T extends HTMLElement>(
  isActive: boolean
): React.RefObject<T | null> => {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!isActive) return;
    const row = ref.current;
    const scroller = row?.closest<HTMLElement>(`[${SIDEBAR_SCROLLER_ATTR}]`);
    if (row == null || scroller == null) return;
    scrollRowIntoSection(scroller, row);
  }, [isActive]);
  return ref;
};
