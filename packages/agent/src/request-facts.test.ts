import { describe, expect, it } from "vitest";

import { factsForChecks, requestSources } from "./request-facts.js";

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});
const said = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const read = (text: string) => ({
  role: "toolResult",
  toolName: "read",
  content: [{ type: "text", text }],
});

// Live (chat u05): the chat bot worked out "+5.6%" itself (it is +8.4%), wrote
// it into its brief to document, and the number check trusted the brief.
// Numbers are checked against what the user gave and what the bot read, never
// against the bot's own words.
describe("what a document's numbers are checked against", () => {
  it("is the user's words and what the bot read, not what the bot wrote", () => {
    const facts = factsForChecks({
      sources: requestSources([
        user("Q3 revenue £186,400, Q2 £171,900. Make it Word and PDF."),
        said("Revenue rose +5.6% on Q2, I will put that in the table."),
        read("Footfall report: 6% down in July."),
      ]),
      files: [],
      brief: "Rows: Total revenue £186,400 / £171,900 / +5.6%",
      original: null,
    });
    expect(facts).toContain("186,400");
    expect(facts).toContain("171,900");
    expect(facts).toContain("6% down in July");
    expect(facts).not.toContain("5.6");
  });
});
