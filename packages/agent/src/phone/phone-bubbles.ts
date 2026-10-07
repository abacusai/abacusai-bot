/**
 * How a phone reply becomes WhatsApp messages. A leaf module, so the hosted
 * app reads it (`@abacus-ai/agent/phone-bubbles`) without the agent runtime.
 */

/** The tool whose text the hosted app sends to WhatsApp at once, mid-turn. */
export const PHONE_PROGRESS_TOOL_NAME = "send_progress";

/** A line holding only this splits a reply into separate WhatsApp bubbles. */
export const PHONE_BUBBLE_MARKER = "---";

/** The loop's way of saying nothing; never sent. */
const NO_REPLY = "NO_REPLY";

/** The reply's bubbles in order: trimmed, with empty and NO_REPLY ones dropped. */
export function splitPhoneBubbles(reply: string): string[] {
  const bubbles: string[][] = [[]];

  for (const line of reply.split(/\r?\n/)) {
    if (line.trim() === PHONE_BUBBLE_MARKER) bubbles.push([]);
    else bubbles.at(-1)?.push(line);
  }

  return bubbles
    .map((lines) => lines.join("\n").trim())
    .filter((bubble) => bubble.length > 0 && bubble !== NO_REPLY);
}
