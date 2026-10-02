/**
 * Opening prompts on the new-session screen. Name and description are
 * localized, the prompt is not: it lands in the composer for the user to edit,
 * and translating it behind their back would change the instructions they
 * think they are sending. Short and concrete, with no clause arguing a choice.
 */

export interface SessionStarter {
  id: string;
  /** i18n keys: workspace.welcome.starters.<id>.name / .description */
  prompt: string;
}

export const SESSION_STARTERS: readonly SessionStarter[] = [
  {
    id: "review-pull-requests",
    prompt:
      "Review the pull requests waiting on my review in this repository. " +
      "For each one, read the diff and tell me in a line or two what it " +
      "changes, then call out anything that looks like a bug, a risk, or a " +
      "missing test, with the file and line, not in general terms. Post a " +
      "short review on each: approve the ones that are genuinely clean, and " +
      "leave actionable comments on the ones that aren't. When you're done, " +
      "tell me which you approved and which still need my eyes. Don't " +
      "change any code yourself.",
  },
  {
    id: "design-an-infographic",
    prompt:
      "Clone n8n-io/n8n into a new folder and read the source code. Then " +
      "create a one-page, vibrant technical infographic PDF explaining " +
      "what n8n does, what actually happens under the hood when a workflow " +
      "runs, and 3 common misconceptions developers have about it. Make " +
      "the architecture/execution flow the visual centerpiece, with " +
      "colorful diagrams, workflow nodes, arrows, small code snippets, and " +
      "polished modern typography. Derive the technical details from the " +
      "source, not generic explanations. Make it feel like a premium " +
      "developer-conference poster, not a document. Save it as a PDF in " +
      "the new folder and open it when finished.",
  },
  {
    id: "build-a-store",
    prompt:
      "Build me a small online store for a boutique candle and home " +
      "fragrance brand. A landing page with a hero, a few featured " +
      "products, and a grid with photos, names and prices. Clicking a " +
      "product opens its page, with a photo gallery, a description, scent " +
      "and size options and an Add to cart button. Add a slide-out cart " +
      "and a simple checkout page. Invent a handful of realistic products " +
      "so it reads as a real shop. Make it premium and modern, with plenty " +
      "of whitespace, and make sure it looks right on a phone.",
  },
  {
    id: "process-a-spreadsheet",
    prompt:
      "Find every spreadsheet in this folder and tell me what is in each " +
      "one. Then clean them: fix the header row, drop empty and duplicate " +
      "rows, and make the numbers and dates real numbers and dates rather " +
      "than text. Summarise each with the totals that matter, on their own " +
      "sheet with a chart, and save the result as a new .xlsx beside the " +
      "original so mine is untouched. Tell me every change you made and " +
      "anything in the data that looked wrong.",
  },
  {
    id: "restyle-a-repo",
    prompt:
      "Clone excalidraw/excalidraw into a folder here and read how it " +
      "styles itself. Then mock up a restyled toolbar and one dialog as a " +
      "single HTML page, using its own colors, type and spacing, with the " +
      "states side by side: default, active tool, and disabled. Open it in " +
      "the pane and tell me what you changed and why.",
  },
  {
    id: "find-flights",
    prompt:
      "Open the browser and find me flights from Bangalore to Paris, out " +
      "Friday evening and back Sunday night. Check a couple of sites " +
      "rather than the first one, then give me three real options with " +
      "times, price, airline and a link each, and say which you'd take.",
  },
];
