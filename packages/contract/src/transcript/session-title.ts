const MAX_TITLE_CHARS = 48;

/**
 * A sidebar-sized title from the first message: mentions keep their filename,
 * slash prefixes drop, fences collapse, and the cut lands on a word boundary.
 */
export const deriveSessionTitle = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*\/(\S+)/, "$1")
    .replace(/@([\w./-]+)/g, (_m, p: string) => p.split("/").pop() ?? p)
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length === 0) return "";
  if (flat.length <= MAX_TITLE_CHARS) return flat;

  // slice() counts UTF-16 code units, so a cut can split a surrogate pair and
  // leave a `�`.
  const clipped = flat
    .slice(0, MAX_TITLE_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = clipped.lastIndexOf(" ");

  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
};
