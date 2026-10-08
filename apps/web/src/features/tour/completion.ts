import { tourStore } from "./store";

export const completeTour = async (
  result: "done" | "skipped",
  deps: {
    persist(result: "done" | "skipped"): Promise<unknown>;
    telemetry(result: "done" | "skipped"): Promise<unknown>;
  }
): Promise<void> => {
  const running = tourStore.state.active;
  if (!running) return;
  const current = () => tourStore.state.active?.runId === running.runId;
  await deps.persist(result);
  if (!current()) return;
  await deps.telemetry(result);
  if (!current()) return;
  tourStore.setState(() => ({ active: null }));
};
