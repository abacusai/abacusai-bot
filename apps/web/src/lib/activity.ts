import { markActivity } from "#platform/lease";
import type { Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";
/** Main's quiet-time clock follows main-window input, at most once per 5 s. */
export const installActivity = (transport: Transport): (() => void) => {
  let last = -Infinity;
  const report = () => {
    const now = Date.now();
    if (now - last < 5000) return;
    last = now;
    markActivity();
    void (
      IS_ELECTRON
        ? transport.client.window.activity()
        : transport.client.system.activity()
    ).catch(() => undefined);
  };
  const events = ["pointerdown", "keydown", "wheel"] as const;
  events.forEach((event) =>
    window.addEventListener(event, report, { capture: true, passive: true })
  );
  return () =>
    events.forEach((event) => window.removeEventListener(event, report, true));
};
