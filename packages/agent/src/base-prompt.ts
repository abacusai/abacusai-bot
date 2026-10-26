/**
 * The start of every system prompt pi builds for us, passed as the loader's
 * `systemPromptOverride` so pi never writes its own default (which introduces
 * pi and its docs). pi adds tool guidelines only to that default, so ours
 * carry them. Fixed per session, not per active tool set: the prompt is the
 * cached prefix of every request.
 */
import { BATCH_READ_GUIDELINES } from "./extensions/batch-read-tool.js";
import {
  BATCH_EDIT_GUIDELINES,
  EDIT_GUIDELINES,
  EDIT_SHARED_GUIDELINES,
} from "./extensions/edit-tool.js";
import { identityPrompt } from "./persona.js";

/** Which `edit` a session has: ours (with batch_edit and batch_file_read) or pi's built-in. */
export type EditTool = "ours" | "builtin";

/** pi's built-in `edit` takes an `edits[]` array, not ours' oldText/newText. */
const BUILTIN_EDIT_GUIDELINES = [
  "Use edit for precise changes: each edits[].oldText must match the file exactly",
  "To change several places in one file, make one edit call with several entries in edits[]",
  "Each edits[].oldText is matched against the original file, so do not overlap or nest edits, and keep it as small as it can be while still unique",
];

const SUB_AGENT_IDENTITY_PROMPT = [
  "You are a sub-agent of AbacusAI Bot, working on one task its main agent handed you.",
  "The model you happen to be running on is not your identity.",
].join("\n");

/**
 * Questions about the app itself go to bot_help, which reads the app's
 * state: from memory the model said routines run on a server and that
 * external models cannot be added. One fixed line, so the cached prefix holds.
 */
export const APP_QUESTIONS_PROMPT =
  "Questions about AbacusAI Bot itself (what it can do, its settings, models, connectors, chat apps, routines, bots, limits, or where something is) are answered from bot_help, never from memory.";

/**
 * Asked for a video, the model wrote "I can't make video here, let me check"
 * and only then called paid_feature, so the plan came second. One fixed line
 * too: a session without the tool skips it.
 */
export const MEDIA_ASKS_PROMPT =
  "Asked to make or edit an image, a video, speech or audio (reading a text aloud too) while you have paid_feature: call it first, before you write anything, and open your reply with what it says makes it, never with what you cannot do.";

/** How to use the file tools; a session without one skips its lines. */
function toolGuidelinesPrompt(edit: EditTool): string {
  const lines = [
    "Be concise in your responses",
    "Show file paths clearly when working with files",
    "Use read to examine files instead of cat or sed",
    "Use write only for new files or complete rewrites",
    "What you delete goes to the Recycle Bin/Trash. Never empty the Recycle Bin/Trash or delete anything in it; if it needs emptying, ask the user to do it",
    ...(edit === "ours"
      ? [
          ...EDIT_GUIDELINES,
          ...BATCH_EDIT_GUIDELINES,
          ...EDIT_SHARED_GUIDELINES,
          ...BATCH_READ_GUIDELINES,
        ]
      : BUILTIN_EDIT_GUIDELINES),
  ];

  return [
    "Guidelines (skip any line about a tool you do not have):",
    "",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

/** A main session's base: who the agent is, then how it uses its tools. */
export function basePrompt(edit: EditTool): string {
  return `${identityPrompt()}\n${APP_QUESTIONS_PROMPT}\n${MEDIA_ASKS_PROMPT}\n\n${toolGuidelinesPrompt(edit)}`;
}

/** A sub-agent's base; the guidelines only where it has file tools. */
export function subAgentBasePrompt(fileTools: boolean): string {
  return fileTools
    ? `${SUB_AGENT_IDENTITY_PROMPT}\n\n${toolGuidelinesPrompt("builtin")}`
    : SUB_AGENT_IDENTITY_PROMPT;
}
