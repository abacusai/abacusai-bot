/**
 * The area and sidebar of the current location (spec 01 §6.3): the deepest
 * match that defines each, so leaf routes inherit from their area layout.
 */
import { useMatches } from "@tanstack/react-router";

import type { ShellArea } from "./layout";

export interface ShellMatch {
  area: ShellArea | undefined;
  sidebar: ShellArea | undefined;
}

export const useShellMatch = (): ShellMatch =>
  useMatches({
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
