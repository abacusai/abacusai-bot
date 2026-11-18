/**
 * A report opens on a cover page only when it is long enough to want one.
 * A two-page report printed a cover that was mostly empty paper, then its
 * text; under about three pages of text the cover becomes a header on the
 * first page, as a memo's is. With its cover, text that spills onto a third
 * page prints four pages, and drops the cover.
 */

/** Whether a document that printed `pages` pages with its cover keeps it. */
export const keepsCover = (pages: number): boolean => pages >= 5;

/** The same HTML with its cover drawn as a first-page header. */
export const withoutCoverPage = (html: string): string =>
  html.replace('<header class="cover">', '<header class="cover compact">');
