interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export const promoPlacement = ({
  width,
  height,
  railRight,
  sidebarRight,
  paneTop,
  cardHeight,
  composer,
  footer,
  splitters,
}: {
  width: number;
  height: number;
  railRight: number;
  sidebarRight: number;
  paneTop: number;
  cardHeight: number;
  composer?: Rect;
  footer?: Rect;
  splitters: Rect[];
}) => {
  let left = Math.max(
    railRight + 16,
    sidebarRight > railRight ? sidebarRight - 64 : 0
  );
  let maxWidth = Math.min(320, width - left - 16);
  const overlapsX = (rect: Rect) =>
    left < rect.right && left + maxWidth > rect.left;
  for (const splitter of splitters) {
    if (
      splitter.bottom - splitter.top > splitter.right - splitter.left &&
      overlapsX(splitter)
    ) {
      maxWidth = Math.min(maxWidth, splitter.left - left - 12);
      if (maxWidth < 240) {
        left = splitter.right + 12;
        maxWidth = Math.min(320, width - left - 16);
      }
    }
  }
  let bottom = 24;
  for (const rect of [composer, footer])
    if (
      rect &&
      overlapsX(rect) &&
      height - bottom > rect.top &&
      height - bottom - cardHeight < rect.bottom
    )
      bottom = Math.max(bottom, height - rect.top + 16);
  for (const splitter of splitters)
    if (
      overlapsX(splitter) &&
      splitter.bottom - splitter.top < splitter.right - splitter.left &&
      height - bottom > splitter.top &&
      height - bottom - cardHeight < splitter.bottom
    )
      bottom = height - splitter.top + 12;
  return {
    left,
    bottom,
    maxWidth,
    visibility:
      maxWidth >= 240 && height - bottom - cardHeight > paneTop + 16
        ? ("visible" as const)
        : ("hidden" as const),
  };
};
