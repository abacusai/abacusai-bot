import type { Transport } from "#next/data/transport";
/** Main's quiet-time clock follows main-window input, at most once per 5 s. */
export const installActivity = (transport: Transport): (() => void) => {
  let last = -Infinity;
  const report = () => {
    const now = Date.now();
    if (now - last < 5000) return;
    last = now;
    void transport.client.window.activity().catch(() => undefined);
  };
  const events = ["pointerdown", "keydown", "wheel"] as const;
  events.forEach((event) =>
    window.addEventListener(event, report, { capture: true, passive: true })
  );
  return () =>
    events.forEach((event) => window.removeEventListener(event, report, true));
};
