/**
 * pi's prompt sends the model to pi's own docs under the agent bundle, which
 * this app does not ship: "how do skills work" became a read of a file that
 * does not exist. The section goes; nothing around it moves.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fakePi } from "@abacus-ai/test-support/fake-pi";
import { describe, expect, it } from "vitest";

import noPiDocs, { withoutPiDocs } from "./no-pi-docs.js";

/** pi's prompt as it comes out of its builder, with our text appended. */
const piPrompt = (): string =>
  [
    "You are an expert coding assistant.",
    "",
    "Guidelines:",
    "- Be concise.",
    "",
    "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
    "- Main documentation: /app/resources/agent/README.md",
    "- Additional docs: /app/resources/agent/docs",
    "- Examples: /app/resources/agent/examples (extensions, custom tools, SDK)",
    "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md)",
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
    "",
    "You are the AbacusAI Bot.",
    "",
    "Current working directory: /work",
  ].join("\n");

/** The heading the pattern keys on, as pi's own source still spells it. */
const piSource = (): string => {
  // ESM-only package with no subpath exports: resolve its entry as ESM.
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent")
  );

  return fs.readFileSync(
    path.join(path.dirname(entry), "core", "system-prompt.js"),
    "utf8"
  );
};

describe("pi's documentation section", () => {
  it("is still spelled the way the pattern expects, in pi's own source", () => {
    expect(piSource()).toContain(
      "Pi documentation (read only when the user asks about pi itself"
    );
    expect(piSource()).toContain("docs/skills.md");
  });

  it("is in pi's own prompt, and gone from ours", () => {
    const original = piPrompt();

    expect(original).toContain("docs/skills.md");

    const trimmed = withoutPiDocs(original);

    expect(trimmed).not.toContain("docs/skills.md");
    expect(trimmed).not.toContain("Pi documentation");
    // Everything around it survives: the guidelines before, our text after.
    expect(trimmed).toContain("Guidelines:");
    expect(trimmed).toContain("You are the AbacusAI Bot.");
    expect(trimmed).toContain("Current working directory: /work");
  });

  it("replaces the prompt for the turn through before_agent_start", async () => {
    const pi = fakePi();
    noPiDocs(pi.api as never);

    const result = await pi.fire("before_agent_start", {
      type: "before_agent_start",
      prompt: "how do skills work?",
      systemPrompt: piPrompt(),
      systemPromptOptions: {},
    });

    expect((result as { systemPrompt?: string })?.systemPrompt).not.toContain(
      "docs/skills.md"
    );
  });

  it("leaves a prompt without the section alone", async () => {
    const pi = fakePi();
    noPiDocs(pi.api as never);

    const result = await pi.fire("before_agent_start", {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "Just this.",
      systemPromptOptions: {},
    });

    expect(result).toBeUndefined();
  });
});
