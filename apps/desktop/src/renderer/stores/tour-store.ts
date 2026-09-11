import { create } from "zustand";

/**
 * Whether the guided tour is running. Nothing is persisted and nothing here
 * decides the tour should run: onboarding and the settings replay start it.
 * Deliberately no persisted "completed" flag, since localStorage clears on a
 * userData move and a flag whose absence starts something would then replay
 * the tour for existing users. Sign-in never replays it either: connecting a
 * connector runs the same sign-in hop.
 */
type TourStore = {
  isOpen: boolean;
  /** Changes for every start so a stale Tourlight instance is replaced. */
  runId: number;
  open: () => void;
  close: () => void;
  /** Drop a tour still up from a previous run, used when onboarding restarts. */
  reset: () => void;
  /** Only closes an open tour; never replays. */
  signedOut: () => void;
};

export const useTourStore = create<TourStore>()((set) => ({
  isOpen: false,
  runId: 0,
  open: () => set((state) => ({ isOpen: true, runId: state.runId + 1 })),
  close: () => set({ isOpen: false }),
  reset: () => set((state) => ({ isOpen: false, runId: state.runId + 1 })),
  signedOut: () => set({ isOpen: false }),
}));
