/**
 * Tools that landed while a turn was running.
 *
 * The tools never change under a running turn (McpToolSync), so a server
 * that gains a tool mid-turn (a refresh main gave up waiting on, a server
 * recovering late) is applied when the turn ends, and the turn is continued
 * once with the arrivals named: the model, otherwise left with "Slack is
 * connected" and no Slack tool, told the user it could not send the message.
 */
export const TOOLS_ARRIVED_TYPE = "abacusai-bot:tools-arrived";

export const toolsArrivedPrompt = (names: readonly string[]): string =>
  `While you were working, these tools became available: ${names.join(", ")}. ` +
  "They are callable now. Carry on with the user's request using them, and " +
  "do not say a tool is missing when it is in this list.";
