export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const placeCard = (
  anchor: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  options = { gap: 16, toolbar: 40 }
): { x: number; y: number } => {
  const clamp = (x: number, y: number) => ({
    x: Math.max(16, Math.min(x, viewport.width - card.width - 16)),
    y: Math.max(
      options.toolbar + 16,
      Math.min(y, viewport.height - card.height - 16)
    ),
  });
  if (!anchor)
    return clamp(
      (viewport.width - card.width) / 2,
      (viewport.height - card.height) / 2
    );
  const { gap } = options;
  if (anchor.x + anchor.width + gap + card.width <= viewport.width - 16)
    return clamp(anchor.x + anchor.width + gap, anchor.y);
  if (anchor.x - gap - card.width >= 16)
    return clamp(anchor.x - gap - card.width, anchor.y);
  if (anchor.y + anchor.height + gap + card.height <= viewport.height - 16)
    return clamp(anchor.x, anchor.y + anchor.height + gap);
  return clamp(anchor.x, anchor.y - gap - card.height);
};
export const waitForAnchor = (
  id: string,
  timeout = 2000,
  signal?: AbortSignal
): Promise<HTMLElement | null> =>
  new Promise((resolve) => {
    let settled = false;
    let frame = 0;
    const resize = new ResizeObserver(() => check());
    const finish = (element: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      signal?.removeEventListener("abort", aborted);
      resolve(element);
    };
    const check = () => {
      const element = document.querySelector<HTMLElement>(
        `[data-tour="${id}"]`
      );
      if (element) resize.observe(element);
      if (
        element?.isConnected &&
        element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0
      )
        finish(element);
    };
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    const aborted = () => finish(null);
    const timer = setTimeout(() => finish(null), timeout);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) finish(null);
    else check();
  });
