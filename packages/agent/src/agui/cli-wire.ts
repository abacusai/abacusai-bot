export const wireRefusal = (
  wire: string | undefined
): { type: "error"; code: "wire_unsupported" } | null =>
  wire == null || wire === "agui"
    ? null
    : { type: "error", code: "wire_unsupported" };
