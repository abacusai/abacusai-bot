/**
 * The template grid's column count: 3 or 4 equal columns. A count that
 * divides the number of templates wins (every row full); otherwise the one
 * whose last row is fuller, so the centred remainder never sits alone.
 */
export const templateColumns = (count: number): 3 | 4 => {
  if (count <= 0) return 3;
  if (count % 3 === 0) return 3;
  if (count % 4 === 0) return 4;
  return count % 3 >= count % 4 ? 3 : 4;
};
