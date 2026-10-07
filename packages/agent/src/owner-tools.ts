/**
 * Tools only the user's own conversations get: the phone loop and a bot's
 * forever chat, never a bot's sender (auto-reply) or routine chat. The
 * desktop says which a session is (ABACUSAI_BOT_AUDIENCE=owner); absent,
 * nothing here is offered. One list, so a profile's tool allowlist names
 * them in one place.
 */
import { abacusBotDir } from "./config.js";
import type { PhoneToolDefinition } from "./phone/phone-tool.js";
import {
  buildTravelerTool,
  type RecentUserText,
  TRAVELER_TOOL_NAME,
} from "./traveler/traveler-tool.js";

export const OWNER_TOOL_NAMES: readonly string[] = [TRAVELER_TOOL_NAME];

/** Whether this session is the user's own, as the desktop that spawned it says. */
export const isOwnerAudience = (): boolean =>
  (process.env.ABACUSAI_BOT_AUDIENCE ?? "").trim() === "owner";

/** The owner-only tools for this session; none unless it is the user's own. */
export function buildOwnerTools(options: {
  recentUserText: RecentUserText;
}): PhoneToolDefinition[] {
  if (!isOwnerAudience()) return [];
  return [
    buildTravelerTool({
      home: abacusBotDir(),
      recentUserText: options.recentUserText.read,
    }),
  ];
}
