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
import { PLAN_ASKS_PROMPT } from "./plan-asks.js";

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

/** Abacus AI's other products, whose docs the model mistook for this app's; base prompt and web note. */
export const OTHER_ABACUS_PRODUCTS =
  "Abacus AI Desktop with its CLI and VS Code extension, ChatLLM, Abacus AI Agent on the web";

/**
 * What this app is, beside Abacus AI's other products, and what chatting costs
 * on every plan; the plan itself is account-plan.ts's line. From memory the
 * model gave another product's CLI steps as this app's and called chatting
 * free. Fixed, so the cached prefix holds.
 */
export const PRODUCT_FACTS_PROMPT = [
  "About this app: AbacusAI Bot runs as a desktop app and on the web at bot.abacus.ai, and answers in WhatsApp, Telegram and Discord through its chat apps.",
  `It is not Abacus AI's other products (${OTHER_ABACUS_PRODUCTS}): their help pages, commands and settings are not this app's.`,
  "This app has no CLI to install, nothing to type in a terminal to set it up and no VS Code extension; its settings are pages in the app.",
  "Questions about AbacusAI Bot itself (how do I, where is, what it can do, its settings, models, provider keys, connectors, chat apps, routines, bots, limits) are answered from bot_help, never from memory or a web page.",
  "Chats, bots and routines on Abacus AI models use the account's credits on every plan, free and paid alike: never say chatting, this chat or small tasks are free or cost nothing.",
  "Only a model on the user's own provider key, or one the model menu lists as free, runs without Abacus credits.",
  "Prices, credits left and what each plan includes are billing_plan's.",
].join(" ");

/**
 * A long silent turn reads as a dead one. One fixed line, so the cached
 * prefix holds; the code's hidden reminders (budgets.ts) back it up. The
 * update rides with a tool call because a text-only message ends the turn.
 */
export const PROGRESS_UPDATES_PROMPT =
  "On a task that takes several steps or minutes, keep the user posted with one short line in their language, written in the same message as your next tool call: before a step that may take minutes, after an attempt fails or times out, and when you change approach. Say something new each time, and never end your reply on such a line.";

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
  return `${identityPrompt()}
${PRODUCT_FACTS_PROMPT}
${PROGRESS_UPDATES_PROMPT}
${MEDIA_ASKS_PROMPT}
${PLAN_ASKS_PROMPT}

${toolGuidelinesPrompt(edit)}`;
}

/** A sub-agent's base; the guidelines only where it has file tools. */
export function subAgentBasePrompt(fileTools: boolean): string {
  return fileTools
    ? `${SUB_AGENT_IDENTITY_PROMPT}\n\n${toolGuidelinesPrompt("builtin")}`
    : SUB_AGENT_IDENTITY_PROMPT;
}
