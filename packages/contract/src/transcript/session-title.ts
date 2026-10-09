/** The opening-message title used by the session composer before the renderer rewrite. */
export const generateSessionTitle = (message: string): string => {
  const firstLine =
    message
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return firstLine.length > 60
    ? `${firstLine.slice(0, 57).trimEnd()}…`
    : firstLine;
};
