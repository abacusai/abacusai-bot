/**
 * A page made by the design system keeps its request beside its source
 * (`name.brief.txt` next to `name.html`). Anything that prints that source
 * again must go through the make step, or the sums, charts and checks are
 * skipped (live F: a `pdf reprint` printed the quiz's marks empty).
 */
import fs from "fs/promises";

export const docsSystemBrief = async (
  htmlPath: string
): Promise<string | null> =>
  fs
    .readFile(htmlPath.replace(/\.html?$/i, ".brief.txt"), "utf8")
    .catch(() => null);
