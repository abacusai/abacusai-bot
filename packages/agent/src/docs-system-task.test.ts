import { describe, expect, it } from "vitest";

import { printFailure } from "./docs-system-task.js";

// Round 4 (bot u01): text printed over the cards. A last print that still
// draws text over text hands over no file, and says why, rather than a broken
// file the user would send on.
describe("a document whose last print failed", () => {
  it("hands over nothing, and tells the bot why", () => {
    const made = {
      pdfPath: null,
      pptxPath: null,
      docxPath: null,
      pages: 7,
      sums: { total: null, marks: null },
      sendBack: [],
      dropped: [],
      failed: ['Slide 2: "Two weeks, every bin" is drawn over a chart.'],
    };
    expect(printFailure(made)).toMatch(
      /^The print failed, so no file was made: Slide 2: "Two weeks, every bin" is drawn over a chart\..*Tell the user/
    );
    expect(printFailure({ ...made, pdfPath: "/w/a.pdf", failed: [] })).toBe(
      null
    );
  });
});
