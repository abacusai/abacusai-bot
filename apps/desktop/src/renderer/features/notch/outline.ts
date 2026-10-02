/** Our bezel outline. Percentages keep the clip attached during size transitions. */
export const notchOutline = (
  width: number | string = "100%",
  height: number | string = "100%",
  top = 12,
  bottom = 20
): string => {
  const w = typeof width === "number" ? `${Math.max(0, width)}px` : width;
  const h = typeof height === "number" ? `${Math.max(0, height)}px` : height;
  const t = Math.max(
    0,
    Math.min(
      top,
      typeof width === "number" ? width / 4 : top,
      typeof height === "number" ? height / 3 : top
    )
  );
  const b = Math.max(
    0,
    Math.min(
      bottom,
      typeof width === "number" ? (width - t * 2) / 2 : bottom,
      typeof height === "number" ? height - t : bottom
    )
  );
  const right = `calc(${w} - ${t}px)`;
  const radius =
    typeof height === "number" ? `${b}px` : `min(${b}px, calc(${h} - ${t}px))`;
  const floor = `calc(${h} - ${radius})`;
  // Coincident corner controls give zero curvature at the straight joins.
  return `shape(from 0px 0px, line to ${w} 0px,
    curve to ${right} ${t}px with ${right} 0px / ${right} 0px,
    line to ${right} ${floor},
    curve to calc(${w} - ${t}px - ${radius}) ${h} with ${right} ${h} / ${right} ${h},
    line to calc(${t}px + ${radius}) ${h},
    curve to ${t}px ${floor} with ${t}px ${h} / ${t}px ${h},
    line to ${t}px ${t}px,
    curve to 0px 0px with ${t}px 0px / ${t}px 0px, close)`;
};
