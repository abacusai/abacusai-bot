/** Two rows for medium tab sets on wide rails; crowded/narrow rails scroll. */
export const railLayout = (count: number, width: number) => {
  const columns = Math.max(1, Math.floor((width + 4) / 116));
  const wrap =
    count > 6 && count <= 12 && width >= 480 && Math.ceil(count / columns) <= 2;
  return {
    mode: wrap ? "wrap" : count <= 6 ? "single" : "scroll",
    rows: wrap ? Math.ceil(count / columns) : 1,
    columns,
  } as const;
};
