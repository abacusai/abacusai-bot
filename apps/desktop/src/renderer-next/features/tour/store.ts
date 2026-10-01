import { Store, useSelector } from "@tanstack/react-store";
export const tourStore = new Store<{
  active: { stopIndex: number; origin: string; startedAt: number } | null;
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
    active: { stopIndex: 0, origin, startedAt: Date.now() },
  }));
};
export const tourSignedOut = (): void =>
  tourStore.setState(() => ({ active: null }));
export const useTourState = () =>
  useSelector(tourStore, (state) => state.active);
