import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { durableStorage } from "../lib/durable-storage";

export type SidebarSection = "bots" | "routines" | "sessions";

interface SidebarAccordionState {
  /** One open section at most: two lists sharing a column left neither with room. */
  openSection: SidebarSection | null;
  toggleSection: (section: SidebarSection) => void;
  /** Make sure this section is open, for a row the route just named. */
  revealSection: (section: SidebarSection) => void;
}

export const useSidebarAccordion = create<SidebarAccordionState>()(
  persist(
    (set) => ({
      // Bots are the product, so they are what a fresh sidebar shows.
      openSection: "bots",
      toggleSection: (section) =>
        set((state) => ({
          openSection: state.openSection === section ? null : section,
        })),
      revealSection: (section) => set({ openSection: section }),
    }),
    {
      name: "sidebar-accordion",
      storage: createJSONStorage(() => durableStorage),
      partialize: (state) => ({ openSection: state.openSection }),
    }
  )
);
