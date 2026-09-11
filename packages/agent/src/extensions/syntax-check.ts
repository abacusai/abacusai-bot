import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Post-edit syntax check: after every successful write/edit, re-parse the
 * file (tree-sitter via ast-grep) and append parse errors to the same tool
 * result, so the model fixes them now rather than from a later test failure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findSyntaxErrors, langForFile } from "../lang.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    const mutates =
      event.toolName === "edit" ||
      event.toolName === "batch_edit" ||
      event.toolName === "write";
    if (!mutates || event.isError) return;

    const input = event.input as { path?: string };
    if (!input.path) return;
    const abs = path.resolve(ctx.cwd, input.path);

    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }

    // JSON: exact, cheap, no grammar needed.
    if (abs.endsWith(".json")) {
      try {
        JSON.parse(source);
      } catch (e: unknown) {
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `⚠ syntax check: ${input.path} is no longer valid JSON (${(e as Error).message}). Fix it before proceeding.`,
            },
          ],
        };
      }
      return;
    }

    const lang = langForFile(abs);
    if (!lang) return;

    let errors;
    try {
      errors = findSyntaxErrors(lang, source);
    } catch {
      return; // never let the checker break the tool result
    }
    if (errors.length === 0) return;

    const details = errors
      .map((e) => `  line ${e.line}: ${e.snippet}`)
      .join("\n");
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text:
            `⚠ syntax check: ${input.path} has ${errors.length} parse error(s) after this change:\n${details}\n` +
            `Fix the syntax before doing anything else.`,
        },
      ],
    };
  });
}
