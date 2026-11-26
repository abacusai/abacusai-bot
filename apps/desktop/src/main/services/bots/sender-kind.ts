/**
 * Which sender sessions are a person on a chat app, answered for the user.
 * Channel turns and another bot's asks are sender sessions too, but the user
 * reads those, so they keep the owner's prompt.
 */
import type { SessionOwner } from "@abacus-ai/contract/contracts";

import { CHANNEL_PLATFORM } from "../channels/channel-service";
import { BOT_ASK_PLATFORM } from "./bot-ask";

/** A remote person's chat: a sender session that is not a channel turn or a bot's ask. */
export const isRemoteSenderOwner = (
  owner: SessionOwner | null | undefined
): boolean =>
  owner?.role === "sender" &&
  owner.platform !== CHANNEL_PLATFORM &&
  owner.platform !== BOT_ASK_PLATFORM;
