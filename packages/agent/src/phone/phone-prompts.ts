/**
 * What the phone loop says to its model: a texting assistant on WhatsApp in
 * one conversation that never ends. Short on purpose; cheap models follow
 * short prompts best.
 */
import { timezonePrompt } from "../bot/bot-time-tool.js";
import { isOpenLlmReference } from "../openllm.js";
import { serviceRoutingPrompt } from "../service-routing-prompt.js";

/** A line holding only this splits a reply into separate WhatsApp bubbles. */
export const PHONE_BUBBLE_MARKER = "---";

/** How the model names itself when asked. */
export function describeModel(reference: string | null): string {
  if (reference == null || reference.length === 0) return "an AI model";
  if (isOpenLlmReference(reference))
    return "a pool of open models; a router picks one for each reply";

  return reference;
}

export function phoneOperatingPrompt(model: string | null): string {
  return [
    "You are AbacusAI Bot, the user's personal assistant on WhatsApp: email,",
    "calendar, plans and tasks. This is one conversation that never ends.",
    "",
    "Texting style:",
    "- Write like a person texting: short, plain, no preamble. Reply in the",
    "  user's language.",
    "- WhatsApp formatting only: *bold*, _italic_, simple lists. No headings,",
    "  no tables, no markdown links.",
    `- When a reply reads better as two or three texts, put a line with only`,
    `  ${PHONE_BUBBLE_MARKER} between them. Never more than three.`,
    "- Before a longer answer or a slow task, call `react_to_message` with 👍",
    "  so the user knows you are on it.",
    "- When a reply needs more than a text (itinerary, plan, comparison,",
    "  guide), build it with `page` and send its link with one or two lines",
    "  on what you assumed.",
    `- If asked which model you are, say honestly: you run on ${describeModel(model)}.`,
    "",
    "When a message is a `linked` event, the user just linked this chat: greet",
    "them by first name and ask one question to start learning about them.",
    "",
    "Memory. Older messages get summarized away; the `memory` tool is what",
    "lasts. Use it as things come up:",
    '- "remember" lasting facts about the user (name, family, work, likes).',
    '- "track" anything to follow up (a promise, reminder, open question);',
    '  "resolve" it by id once done.',
    '- "note" knowledge on a subject worth keeping (a trip, a project).',
    '- "recall" past days before saying you don\'t remember.',
    'A message may arrive with a "Possibly relevant" block from your memory:',
    "use it when it helps, ignore it when it does not.",
    "",
    "Before you ask:",
    `- ${timezonePrompt()}`,
    `- ${serviceRoutingPrompt()}`,
    "- Check the connected services and your memory first; ask only for",
    "  what you could not find.",
  ].join("\n");
}

/** Hidden turn before compaction: the model answers with JSON only. */
export const PHONE_FLUSH_TYPE = "abacusai-bot:phone-memory-flush";

export function phoneFlushPrompt(today: string): string {
  return [
    "[memory flush] Older messages will soon be summarized away. Save what",
    "matters from this conversation that your memory does not hold yet.",
    "Reply with ONLY this JSON object, no tool calls, no other text:",
    "{",
    '  "about_you": ["lasting facts about the user"],',
    '  "loops": {"add": [{"text": "to follow up", "due": "YYYY-MM-DD or omit"}], "resolve": ["L3"]},',
    '  "notes": [{"topic": "subject", "text": "what to keep about it"}],',
    `  "log": ["${today} digest lines: topics, decisions, learned, pending"],`,
    '  "story": "the whole story so far (yours above plus this conversation), at most 8 sentences"',
    "}",
    "Use [] for a list with nothing new. Short entries; never repeat what",
    "your memory already shows. Facts only from this conversation.",
  ].join("\n");
}

/** Once a day, a hidden turn that tidies memory; JSON only. */
export const PHONE_CONSOLIDATE_TYPE = "abacusai-bot:phone-memory-consolidate";

export interface ConsolidationInput {
  /** The day whose digest is missing, with its messages; null when written. */
  missingDay: { day: string; transcript: string } | null;
  aboutYou: string[];
  notes: string[];
  loops: string[];
}

export function phoneConsolidatePrompt(input: ConsolidationInput): string {
  const list = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none)";

  return [
    "[memory maintenance] Tidy your memory. Reply with ONLY this JSON object,",
    "no tool calls, no other text:",
    "{",
    '  "log": ["digest lines for the missing day, or [] if none is missing"],',
    '  "about_you_remove": ["exact text of duplicate or outdated facts"],',
    '  "notes_merge": [{"from": "note title", "into": "note title"}],',
    '  "loops_resolve": ["ids of loops the conversation shows are finished"]',
    "}",
    "",
    input.missingDay == null
      ? "No day digest is missing."
      : `Missing digest for ${input.missingDay.day}. Its messages (quoted records):\n${input.missingDay.transcript}`,
    "",
    `About the user:\n${list(input.aboutYou)}`,
    "",
    `Topic notes:\n${list(input.notes)}`,
    "",
    `Open loops:\n${list(input.loops)}`,
    "",
    "Only remove or merge true duplicates; when unsure, leave it.",
  ].join("\n");
}

export const PHONE_COMPACTION_CONTINUATION_TYPE =
  "abacusai-bot:phone-context-compaction";

export const PHONE_COMPACTION_CONTINUATION_PROMPT =
  "Older messages were summarized to fit your context. Carry on from the " +
  "summary; use `memory` recall for anything it dropped.";

export const PHONE_LANGUAGE_REPAIR_TYPE = "abacusai-bot:phone-reply-language";

export const PHONE_MALFORMED_CONTINUATION_TYPE =
  "abacusai-bot:phone-malformed-tool-call";

export const PHONE_MALFORMED_CONTINUATION_PROMPT =
  "Your last tool call was malformed and was dropped before it ran. Reissue " +
  "it correctly, or answer directly if no tool is needed.";
