import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, type RefObject } from "react";

import type { ArtifactListEntry } from "./data";

// Keep the virtualizer's mutable instance outside React Compiler's cached render.
export const useArtifactWindow = (
  entries: ArtifactListEntry[],
  columns: number,
  list: boolean,
  viewport: RefObject<HTMLDivElement | null>,
  selected?: string
) => {
  "use no memo";
  // oxlint-disable-next-line incompatible-library -- This hook explicitly opts out of compiler caching.
  const virtualizer = useVirtualizer({
    count: Math.ceil(entries.length / columns),
    getScrollElement: () => viewport.current,
    estimateSize: () => (list ? 72 : 190),
    overscan: 4,
    initialRect: { width: 800, height: 800 },
    getItemKey: (index) => {
      const entry = entries[index * columns]!;
      return "artifact" in entry ? entry.artifact.id : entry.day;
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const firstRow = virtualRows[0];
  const lastRow = virtualRows.at(-1);
  const selectedIndex = selected
    ? entries.findIndex(
        (entry) => "artifact" in entry && entry.artifact.id === selected
      )
    : -1;
  useEffect(() => {
    if (selectedIndex >= 0)
      virtualizer.scrollToIndex(Math.floor(selectedIndex / columns), {
        align: "auto",
      });
  }, [selectedIndex, columns, virtualizer]);
  return {
    start: (firstRow?.index ?? 0) * columns,
    end: ((lastRow?.index ?? -1) + 1) * columns,
    before: firstRow?.start ?? 0,
    after: virtualizer.getTotalSize() - (lastRow?.end ?? 0),
  };
};
