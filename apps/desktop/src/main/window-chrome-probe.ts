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

// One executeJavaScript call, no IPC surface. Wait for first geometry rather
// than interpreting an unpainted view as an unsupported compositor.
export const OVERLAY_PROBE_SCRIPT = `(() => new Promise(resolve => {
  const deadline = performance.now() + 1500;
  const check = () => {
    const overlay = navigator.windowControlsOverlay;
    const rect = overlay?.getTitlebarAreaRect();
    const geometry = rect ? {
      visible: overlay.visible, x: rect.x, width: rect.width,
      height: rect.height, windowWidth: innerWidth
    } : null;
    if ((geometry?.visible && rect.width > 0 && rect.height > 0 &&
         rect.width < innerWidth) || performance.now() >= deadline) {
      resolve(geometry);
    } else {
      requestAnimationFrame(check);
    }
  };
  check();
}))()`;

export async function probeWindowChrome(
  read: () => Promise<OverlayGeometry | null>
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
      }),
    ]);
    return hasOverlayGeometry(result);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
