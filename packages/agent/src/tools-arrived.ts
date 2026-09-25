/**
 * Tools that landed while a turn was running.
 *
 * pi fixes the tool list for a turn when the turn starts, so a server that
 * gains a tool mid-turn (the Slack connector a user adds from the chat
 * itself, via connect_connector) registers fine and is callable on the
 * NEXT turn, while the rest of THIS turn cannot see it. The model, handed
 * "Slack is connected" and no Slack tool, told the user it could not send
 * the message. The turn is continued instead, with the arrivals named.
 */
export const TOOLS_ARRIVED_TYPE = "abacusai-bot:tools-arrived";

export const toolsArrivedPrompt = (names: readonly string[]): string =>
  `While you were working, these tools became available: ${names.join(", ")}. ` +
  "They are callable now. Carry on with the user's request using them, and " +
  "do not say a tool is missing when it is in this list.";
