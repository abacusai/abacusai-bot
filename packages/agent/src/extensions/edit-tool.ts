import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The edit tool. Replaces pi's built-in `edit` (an extension tool wins over a
 * built-in of the same name) to add `replaceAll` and the relaxed matching in
 * `edit-resolve.ts`. Kept from the built-in: edits match the ORIGINAL file,
 * BOM and CRLF survive the round-trip, and the result carries the same
 * `diff`/`patch`/`firstChangedLine` details the desktop and TUI render.
 */
import {
  createEditToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  lineOf,
  resolveEdit,
  spliceRanges,
  type StrategyName,
} from "../edit-resolve.js";
import { findSyntaxErrors, langForFile } from "../lang.js";

const REPLACE_ALL_DESCRIPTION =
  "Replace every occurrence of oldText instead of requiring it to be unique. " +
  "Use for renames and other repeated changes; leave unset to change one specific place.";

const OLD_TEXT_DESCRIPTION = "Text to replace. Must appear in the file.";
const NEW_TEXT_DESCRIPTION = "Replacement text.";

/** One change per call: the common shape, without a one-element array. */
const editSchema = Type.Object({
  path: Type.String({ description: "File to modify" }),
  oldText: Type.String({ description: OLD_TEXT_DESCRIPTION }),
  newText: Type.String({ description: NEW_TEXT_DESCRIPTION }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: REPLACE_ALL_DESCRIPTION })
  ),
});

/**
 * Several changes to one file in a single call, saving round trips. A separate
 * tool rather than an optional array on `edit`, so each tool has one shape.
 */
const batchEditSchema = Type.Object({
  path: Type.String({ description: "File to modify" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: OLD_TEXT_DESCRIPTION }),
      newText: Type.String({ description: NEW_TEXT_DESCRIPTION }),
      replaceAll: Type.Optional(
        Type.Boolean({ description: REPLACE_ALL_DESCRIPTION })
      ),
    }),
    {
      description:
        "Edits to apply. Every oldText is matched against the original file, " +
        "not against the result of earlier edits, so they must not overlap.",
    }
  ),
});

export interface RequestedEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface EditDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

/** How a relaxed match is described back to the model. */
const STRATEGY_NOTE: Record<Exclude<StrategyName, "exact">, string> = {
  "unicode-normalized": "ignoring Unicode punctuation and trailing whitespace",
  "line-trimmed": "ignoring leading and trailing whitespace on each line",
  "block-anchor": "on the first and last line of the block",
  "whitespace-normalized": "ignoring how whitespace was distributed",
  "indentation-flexible": "ignoring the indentation level of the block",
  "escape-normalized": "unescaping backslash sequences",
  "trimmed-boundary": "ignoring blank lines around the block",
  "context-anchored": "on the surrounding lines",
};

function fail(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    details: undefined,
  };
}

/** Apply edits to one file; shared by `edit` and `batch_edit` so they agree. */
async function applyFileEdits(
  filePath: string,
  requested: RequestedEdit[],
  ctx: { cwd: string }
) {
  const abs = path.resolve(ctx.cwd, filePath);

  if (requested.length === 0) {
    return fail("No edits supplied.");
  }

  let raw: string;
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory())
      return fail(`${filePath} is a directory, not a file.`);
    raw = fs.readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fail(`${filePath} does not exist. Use write to create it.`);
    }
    return fail(`Cannot read ${filePath}: ${(error as Error).message}`);
  }

  // A NUL byte means this is not text; splicing a lossy decode corrupts it.
  if (raw.includes("\u0000")) {
    return fail(
      `${filePath} looks like a binary file. edit only works on text.`
    );
  }

  // Match against a normalized view, then restore what we stripped, so a
  // CRLF file stays CRLF and a BOM survives the round-trip.
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? raw.slice(1) : raw;
  const crlf = withoutBom.includes("\r\n");
  const content = crlf ? withoutBom.replaceAll("\r\n", "\n") : withoutBom;

  const patches: Array<{
    start: number;
    end: number;
    text: string;
    index: number;
  }> = [];
  const notes: string[] = [];
  let widened = false;

  for (const [index, edit] of requested.entries()) {
    const newText = crlf ? edit.newText.replaceAll("\r\n", "\n") : edit.newText;
    const oldText = crlf ? edit.oldText.replaceAll("\r\n", "\n") : edit.oldText;
    const replaceAll = edit.replaceAll === true;
    const result = resolveEdit(content, oldText, newText, replaceAll);
    const label = requested.length > 1 ? `edits[${index}]` : "the edit";

    if (!result.ok) {
      switch (result.failure.kind) {
        case "empty":
          return fail(
            `${label} has an empty oldText. Give the exact text to replace, ` +
              `or use write to replace the whole file.`
          );
        case "identical":
          return fail(
            `${label} has identical oldText and newText, so it would change nothing.`
          );
        case "not-found":
          return fail(
            `Could not find ${label} in ${filePath}, even allowing for whitespace and ` +
              `indentation differences. Re-read the file and quote the text as it actually appears.`
          );
        case "ambiguous": {
          const { count, lines } = result.failure;
          const shown = lines.slice(0, 10).join(", ");
          return fail(
            `${label} matches ${count} places in ${filePath} (lines ${shown}` +
              `${lines.length > 10 ? ", …" : ""}). Add surrounding context to pick one, ` +
              `or set replaceAll: true on this edit to change all of them.`
          );
        }
        case "disproportionate":
          return fail(
            `${label} could only be matched loosely, and the match spans ` +
              `${result.failure.matchedLines} lines for a ${result.failure.askedLines}-line ` +
              `oldText — too much to replace safely. Re-read ${filePath} and quote the exact text.`
          );
      }
    }

    if (result.relaxed) {
      notes.push(
        `${label} matched by ${STRATEGY_NOTE[result.strategy as Exclude<StrategyName, "exact">]}`
      );
    }
    if (result.ranges.length > 1) widened = true;

    for (const range of result.ranges) {
      patches.push({ ...range, text: newText, index });
    }
  }

  // All edits address the original file, so two touching the same span would
  // silently drop one in the splice.
  const ordered = [...patches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      return fail(
        `edits[${previous.index}] and edits[${current.index}] overlap in ${filePath} ` +
          `(around line ${lineOf(content, current.start)}). Merge them into one edit.`
      );
    }
  }

  const updated = spliceRanges(content, patches);
  if (updated === content) {
    return fail(
      `No changes were made to ${filePath}: the edits produced identical content.`
    );
  }

  // A single splice may be a deliberately broken intermediate state and only
  // gets syntax-check's warning; a replaceAll over several sites can wreck a
  // file wholesale and is refused outright, like ast_edit.
  if (widened) {
    const lang = langForFile(abs);
    if (lang) {
      try {
        const before = findSyntaxErrors(lang, content).length;
        const after = findSyntaxErrors(lang, updated);
        if (after.length > before) {
          return fail(
            `Refusing this edit: replacing every occurrence would introduce ` +
              `${after.length - before} syntax error(s) in ${filePath}. ` +
              // Quoted, not parenthesised: a wrapping paren would visually
              // close the unclosed bracket broken code usually ends in.
              `First at line ${after[0]?.line}: "${after[0]?.snippet}". ` +
              `The file is unchanged. Narrow the edit or fix the replacement text.`
          );
        }
      } catch {
        // A checker failure must never block a legitimate edit.
      }
    }
  }

  const restored = bom + (crlf ? updated.replaceAll("\n", "\r\n") : updated);
  try {
    fs.writeFileSync(abs, restored, "utf8");
  } catch (error) {
    return fail(`Cannot write ${filePath}: ${(error as Error).message}`);
  }

  const { diff, firstChangedLine } = generateDiffString(content, updated);
  const summary =
    patches.length === requested.length
      ? `Applied ${requested.length} edit(s) to ${filePath}.`
      : `Applied ${requested.length} edit(s) to ${filePath}, replacing ${patches.length} occurrence(s).`;

  return {
    content: [
      {
        type: "text" as const,
        text: notes.length > 0 ? `${summary}\n${notes.join("\n")}.` : summary,
      },
    ],
    details: {
      diff,
      patch: generateUnifiedPatch(filePath, content, updated),
      ...(firstChangedLine != null && { firstChangedLine }),
    } satisfies EditDetails,
  };
}

const SHARED_GUIDELINES = [
  "Each oldText is matched against the original file, so quote it as the file actually reads. Read the file first.",
  "Keep oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  "To change every occurrence of the same text, set replaceAll: true instead of repeating the edit or padding it with context.",
];

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description:
      "Replace exact text in a file. Pass path, oldText and newText. " +
      "Read the file first so oldText matches what is actually there, and keep it as small as it can be " +
      "while still identifying one place. " +
      "Set replaceAll: true to change every occurrence — use it for renames rather than padding oldText " +
      "with context until it is unique. " +
      "To change several separate places in the same file, use batch_edit instead of calling this repeatedly.",
    parameters: editSchema,
    promptSnippet: "Replace exact text in a file",
    promptGuidelines: [
      "Use edit for a single precise change: pass path, oldText and newText",
      "When changing several separate places in one file, use batch_edit in a single call rather than calling edit repeatedly",
      ...SHARED_GUIDELINES,
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return applyFileEdits(params.path, [params], ctx);
    },

    // The borrowed renderers only read `path` and `edits`, so a flat call is
    // presented in the batch shape.
    renderCall: (args, theme, context) =>
      borrowedRenderers.renderCall!(
        { path: args.path, edits: [args] } as never,
        theme,
        context as never
      ),
    renderResult: borrowedRenderers.renderResult as never,
  });

  pi.registerTool({
    name: "batch_edit",
    label: "Batch Edit",
    description:
      "Replace text in several places in one file, in a single call. " +
      "Read the file first. Every oldText is matched against the original file, not against the result of " +
      "earlier edits, so the edits must not overlap — merge nearby changes into one entry. " +
      "Prefer this over calling edit repeatedly on the same file. For a single change, use edit.",
    parameters: batchEditSchema,
    promptSnippet: "Replace text in several places in one file, in one call",
    promptGuidelines: [
      "Use batch_edit when one file needs changes in several separate places, instead of several edit calls",
      "Do not emit overlapping or nested edits. Merge nearby changes into one entry.",
      ...SHARED_GUIDELINES,
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return applyFileEdits(params.path, params.edits, ctx);
    },

    renderCall: borrowedRenderers.renderCall,
    renderResult: borrowedRenderers.renderResult,
  });
}

/**
 * The built-in edit definition, used purely as a source of TUI renderers so
 * this tool looks exactly like the one it replaces. Its `cwd` only reaches
 * `execute`, which is never called here.
 */
const borrowedRenderers = createEditToolDefinition(
  process.cwd()
) as unknown as Pick<
  ToolDefinition<typeof batchEditSchema, EditDetails | undefined>,
  "renderCall" | "renderResult"
>;
