import { Store, useSelector } from "@tanstack/react-store";
let nextRun = 0;
export const tourStore = new Store<{
  active: {
    runId: number;
    stopIndex: number;
    origin: string;
    startedAt: number;
  } | null;
}>({ active: null });
export const startTour = ({
  origin,
  onboarded = false,
}: {
  origin: string;
  onboarded?: boolean;
}): void => {
  if (!onboarded || tourStore.state.active) return;
  tourStore.setState(() => ({
    active: { runId: ++nextRun, stopIndex: 0, origin, startedAt: Date.now() },
  }));
};
export const tourSignedOut = (): void =>
  tourStore.setState(() => ({ active: null }));
export const useTourState = () =>
  useSelector(tourStore, (state) => state.active);
