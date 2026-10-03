/** DEC SGR and X10 byte encoders shared by both renderers. */
export const encodeMouse = (
  sgr: boolean,
  button: number,
  col: number,
  row: number,
  released: boolean
): string | null => {
  if (sgr) return `[<${button};${col};${row}${released ? "m" : "M"}`;
  if (col > 223 || row > 223) return null;
  // The button bits go, the modifier and motion bits stay.
  const code = released ? (button & ~3) | 3 : button;

  return `[M${String.fromCharCode(code + 32, col + 32, row + 32)}`;
};
