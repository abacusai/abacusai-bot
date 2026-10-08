/** One row by default; opt-in medium sets may wrap once when they fit. */
export const railLayout = (
  count: number,
  width: number,
  allowTwoRows = false
) => {
  const columns = Math.max(1, Math.floor((width + 4) / 116));
  const wrap =
    allowTwoRows &&
    count > 6 &&
    count <= 12 &&
    width >= 480 &&
    Math.ceil(count / columns) <= 2;
  return {
    mode: wrap ? "wrap" : count <= 6 ? "single" : "scroll",
    rows: wrap ? Math.ceil(count / columns) : 1,
    columns,
  } as const;
};
