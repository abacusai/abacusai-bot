/**
 * How wide a chat bubble may get. Both voices share it: two sides reading to
 * different widths made the column look broken. A rem cap keeps a line of prose
 * from spanning a 2000px window; the percentage keeps the far side visibly
 * open, which is what says "this side spoke, that side did not".
 */
export const BUBBLE_MAX_WIDTH = "max-w-[min(60rem,85%)]";
