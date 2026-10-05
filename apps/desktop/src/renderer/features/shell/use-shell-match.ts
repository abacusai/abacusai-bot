/**
 * The area and sidebar of the current location (spec 01 §6.3): the deepest
 * match that defines each, so leaf routes inherit from their area layout.
 */
import { useMatches, useLocation } from "@tanstack/react-router";

import type { ShellArea } from "./layout";

export interface ShellMatch {
  area: ShellArea | undefined;
  sidebar: ShellArea | undefined;
}

export const useShellMatch = (): ShellMatch => {
  const pathname = useLocation({ select: (location) => location.pathname });
  const match = useMatches({
    select: (matches: Array<{ staticData: unknown }>) => {
      let area: ShellArea | undefined;
      let sidebar: ShellArea | undefined;
      for (const match of matches) {
        const data = match.staticData as {
          area?: ShellArea;
          sidebar?: ShellArea;
        };
        area = data.area ?? area;
        sidebar = data.sidebar ?? sidebar;
      }
      return { area, sidebar };
    },
    structuralSharing: true,
  } as never) as unknown as ShellMatch;
  const segment = pathname.split("/")[1];
  const fallback = [
    "bots",
    "sessions",
    "routines",
    "artifacts",
    "library",
    "settings",
  ].includes(segment ?? "")
    ? (segment as ShellArea)
    : undefined;
  return { area: match.area ?? fallback, sidebar: match.sidebar ?? fallback };
};
