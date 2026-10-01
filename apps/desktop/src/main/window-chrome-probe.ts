export interface OverlayGeometry {
  visible: boolean;
  x: number;
  width: number;
  height: number;
  windowWidth: number;
}

export function hasOverlayGeometry(value: OverlayGeometry | null): boolean {
  return (
    value !== null &&
    value.visible &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.width > 0 &&
    value.height > 0 &&
    value.windowWidth > 0 &&
    value.width < value.windowWidth &&
    value.x + value.width <= value.windowWidth + 1
  );
}

// Each poll executes on the host's current webContents, including after a swap.
export const OVERLAY_PROBE_SCRIPT = `(() => {
  const overlay = navigator.windowControlsOverlay;
  const rect = overlay?.getTitlebarAreaRect();
  return rect ? {
    visible: overlay.visible, x: rect.x, width: rect.width,
    height: rect.height, windowWidth: innerWidth
  } : null;
})()`;

export type ChromeProbeResult = "available" | "unavailable" | "retry-later";

export async function probeWindowChrome(
  read: () => Promise<OverlayGeometry | null>,
  retryLater: () => boolean = () => false
): Promise<ChromeProbeResult> {
  const deadline = Date.now() + 1500;
  while (true) {
    if (retryLater()) return "retry-later";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        read(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => resolve(undefined),
            Math.max(0, deadline - Date.now())
          );
        }),
      ]);
      if (retryLater() || result === undefined) return "retry-later";
      if (hasOverlayGeometry(result)) return "available";
    } catch {
      return "retry-later";
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) return "unavailable";
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(50, deadline - Date.now()))
    );
  }
}

/** Park a probe on a native state event instead of polling an invisible window. */
export function waitForChromeProbeWindow(
  window: {
    isVisible(): boolean;
    isMinimized(): boolean;
    isFullScreen(): boolean;
    once(event: string, listener: () => void): unknown;
  },
  probe: () => void
): boolean {
  const event = window.isMinimized()
    ? "restore"
    : window.isFullScreen()
      ? "leave-full-screen"
      : !window.isVisible()
        ? "show"
        : null;
  if (event === null) return false;
  window.once(event, probe);
  return true;
}
