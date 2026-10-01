/** The Simulator title bar occupies the space above its bottom-aligned screen. */
export const simulatorCrop = (
  width: number,
  height: number,
  aspect: number | null
) => {
  const contentHeight =
    aspect && aspect > 0
      ? Math.min(height, Math.round(width / aspect))
      : height;
  return { x: 0, y: height - contentHeight, width, height: contentHeight };
};
export const devicePoint = (
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
  width: number,
  height: number
) => {
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const left = bounds.left + (bounds.width - width * scale) / 2;
  const top = bounds.top + (bounds.height - height * scale) / 2;
  return {
    x: Math.max(0, Math.min(width, (x - left) / scale)),
    y: Math.max(0, Math.min(height, (y - top) / scale)),
  };
};
