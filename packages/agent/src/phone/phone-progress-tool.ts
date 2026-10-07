/**
 * `send_progress`: a short WhatsApp message that goes out now, mid-turn, as
 * a reply to the user's message. The tool only checks the text; the hosted
 * app sees the call and sends it.
 */
import {
  parseProgressText,
  PHONE_PROGRESS_TOOL_NAME,
} from "./phone-bubbles.js";
import { type PhoneToolDefinition, toolText } from "./phone-tool.js";

export function buildPhoneProgressTool(): PhoneToolDefinition {
  return {
    name: PHONE_PROGRESS_TOOL_NAME,
    label: PHONE_PROGRESS_TOOL_NAME,
    description: [
      "Send the user one short WhatsApp message right now, while you keep working.",
      "It goes out at once as a reply to their latest message; your final answer still",
      "comes at the end. Use it to acknowledge a longer task, at each real milestone,",
      'for an early finding ("Early signal: ..."), and to answer a question they send',
      "mid-task. One or two plain lines in the user's language; never the final answer.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The message, one or two lines.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const parsed = parseProgressText(params);
      return parsed.ok === false
        ? toolText(parsed.reason, true)
        : toolText("Sent.");
    },
  };
}
