interface PromoObstacle {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
/** Keep the promo on the window's bottom edge; occupied slots never push it upward. */
export const promoPlacement = ({
  width,
  height,
  railRight,
  sidebarRight,
  cardHeight,
  obstacles,
}: {
  width: number;
  height: number;
  railRight: number;
  sidebarRight: number;
  cardHeight: number;
  obstacles: PromoObstacle[];
}) => {
  const inset = 16;
  const bottom = 24;
  const start = Math.max(railRight, sidebarRight) + inset;
  const fit = (cardWidth: number, cardHeight: number) => {
    const top = height - bottom - cardHeight;
    if (top < inset) return;
    const candidates = [
      start,
      ...obstacles.flatMap((r) => [
        r.right + inset,
        r.left - cardWidth - inset,
      ]),
    ]
      .filter((left) => left >= start && left + cardWidth <= width - inset)
      .sort((a, b) => a - b);
    return candidates.find(
      (left) =>
        !obstacles.some(
          (r) =>
            left < r.right + inset &&
            left + cardWidth > r.left - inset &&
            top < r.bottom + inset &&
            height - bottom > r.top - inset
        )
    );
  };
  for (const maxWidth of [320, 240]) {
    const left = fit(maxWidth, cardHeight);
    if (left != null)
      return {
        left,
        bottom,
        maxWidth,
        compact: false,
        visibility: "visible" as const,
      };
  }
  const maxWidth = 176;
  const left = fit(maxWidth, 44);
  return {
    left: left ?? start,
    bottom,
    maxWidth,
    compact: true,
    visibility: left != null ? ("visible" as const) : ("hidden" as const),
  };
};
