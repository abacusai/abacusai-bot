import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { durableStorage } from "../lib/durable-storage";

// Credits come back on a schedule this app does not know, so the mark lapses.
export const CREDITS_EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;

interface CreditsState {
  /** When a turn last died for want of free credits. */
  exhaustedAt: number | null;
  markExhausted: () => void;
  clearExhausted: () => void;
}

// The turn that dies with "no remaining credits" is fresher than the account
// poll; the upgrade card sets this so the sidebar keeps showing the way out.
export const useCreditsStore = create<CreditsState>()(
  persist(
    (set) => ({
      exhaustedAt: null,
      markExhausted: () => set({ exhaustedAt: Date.now() }),
      clearExhausted: () => set({ exhaustedAt: null }),
    }),
    {
      name: "abacus-credits",
      storage: createJSONStorage(() => durableStorage),
      partialize: (state) => ({ exhaustedAt: state.exhaustedAt }),
    }
  )
);

export const isExhaustedMarkLive = (
  exhaustedAt: number | null,
  now = Date.now()
): boolean =>
  exhaustedAt != null && now - exhaustedAt < CREDITS_EXHAUSTED_TTL_MS;
