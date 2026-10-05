import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { readSourceFiles } from "#renderer/test-support/source-files";
// Frozen from C5 d8bccf17 before deleting the legacy tree.
const old =
  '/**\n * Opening prompts on the new-session screen. Name and description are\n * localized, the prompt is not: it lands in the composer for the user to edit,\n * and translating it behind their back would change the instructions they\n * think they are sending. Short and concrete, with no clause arguing a choice.\n */\n\nexport interface SessionStarter {\n  id: string;\n  /** i18n keys: workspace.welcome.starters.<id>.name / .description */\n  prompt: string;\n}\n\nexport const SESSION_STARTERS: readonly SessionStarter[] = [\n  {\n    id: "review-pull-requests",\n    prompt:\n      "Review the pull requests waiting on my review in this repository. " +\n      "For each one, read the diff and tell me in a line or two what it " +\n      "changes, then call out anything that looks like a bug, a risk, or a " +\n      "missing test, with the file and line, not in general terms. Post a " +\n      "short review on each: approve the ones that are genuinely clean, and " +\n      "leave actionable comments on the ones that aren\'t. When you\'re done, " +\n      "tell me which you approved and which still need my eyes. Don\'t " +\n      "change any code yourself.",\n  },\n  {\n    id: "design-an-infographic",\n    prompt:\n      "Clone n8n-io/n8n into a new folder and read the source code. Then " +\n      "create a one-page, vibrant technical infographic PDF explaining " +\n      "what n8n does, what actually happens under the hood when a workflow " +\n      "runs, and 3 common misconceptions developers have about it. Make " +\n      "the architecture/execution flow the visual centerpiece, with " +\n      "colorful diagrams, workflow nodes, arrows, small code snippets, and " +\n      "polished modern typography. Derive the technical details from the " +\n      "source, not generic explanations. Make it feel like a premium " +\n      "developer-conference poster, not a document. Save it as a PDF in " +\n      "the new folder and open it when finished.",\n  },\n  {\n    id: "build-a-store",\n    prompt:\n      "Build me a small online store for a boutique candle and home " +\n      "fragrance brand. A landing page with a hero, a few featured " +\n      "products, and a grid with photos, names and prices. Clicking a " +\n      "product opens its page, with a photo gallery, a description, scent " +\n      "and size options and an Add to cart button. Add a slide-out cart " +\n      "and a simple checkout page. Invent a handful of realistic products " +\n      "so it reads as a real shop. Make it premium and modern, with plenty " +\n      "of whitespace, and make sure it looks right on a phone.",\n  },\n  {\n    id: "process-a-spreadsheet",\n    prompt:\n      "Find every spreadsheet in this folder and tell me what is in each " +\n      "one. Then clean them: fix the header row, drop empty and duplicate " +\n      "rows, and make the numbers and dates real numbers and dates rather " +\n      "than text. Summarise each with the totals that matter, on their own " +\n      "sheet with a chart, and save the result as a new .xlsx beside the " +\n      "original so mine is untouched. Tell me every change you made and " +\n      "anything in the data that looked wrong.",\n  },\n  {\n    id: "restyle-a-repo",\n    prompt:\n      "Clone excalidraw/excalidraw into a folder here and read how it " +\n      "styles itself. Then mock up a restyled toolbar and one dialog as a " +\n      "single HTML page, using its own colors, type and spacing, with the " +\n      "states side by side: default, active tool, and disabled. Open it in " +\n      "the pane and tell me what you changed and why.",\n  },\n  {\n    id: "find-flights",\n    prompt:\n      "Open the browser and find me flights from Bangalore to Paris, out " +\n      "Friday evening and back Sunday night. Check a couple of sites " +\n      "rather than the first one, then give me three real options with " +\n      "times, price, airline and a link each, and say which you\'d take.",\n  },\n];\n';
import { SESSION_STARTERS } from "#renderer/features/sessions/starters";

import current from "../../features/sessions/starters.ts?raw";
const sources = readSourceFiles(
  [
    "../../features/sessions/**/*.{ts,tsx}",
    "../../routes/_shell/(sessions)/*.{ts,tsx}",
  ],
  import.meta.dirname
);
it("R4-T22 literal session translation keys resolve", () => {
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/t\(\s*["'](sessions\.[\w.-]+)["']/g)) {
      const value = match[1]!
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)?.[key],
          enUS
        );
      expect(typeof value, `${file}: ${match[1]}`).toBe("string");
    }
  }
});
it("R4-T22 starter prompts remain byte-identical to the existing prompts", () => {
  expect(current).toBe(old);
  expect(SESSION_STARTERS).toHaveLength(6);
  for (const starter of SESSION_STARTERS)
    expect(enUS.sessions.start.starters).toHaveProperty(starter.id);
});
