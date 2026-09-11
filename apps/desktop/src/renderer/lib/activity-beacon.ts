/**
 * Tell the main process the user is interacting, throttled. The renderer
 * swap (scheduleRendererSwap in main) defers while input is recent, so an
 * experience update never lands under someone mid-keystroke.
 */
const THROTTLE_MS = 5_000;

export const installActivityBeacon = (): void => {
  let lastReport = 0;
  const report = (): void => {
    const now = Date.now();

    if (now - lastReport < THROTTLE_MS) return;

    lastReport = now;

    try {
      window.api?.reportUiActivity?.();
    } catch {
      // A shell without the channel; the swap just keeps its old gates.
    }
  };

  for (const event of ["keydown", "pointerdown", "wheel"] as const) {
    window.addEventListener(event, report, { capture: true, passive: true });
  }
};
