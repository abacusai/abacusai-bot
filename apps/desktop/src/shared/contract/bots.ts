import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { AVATAR_ACCESSORY_IDS } from "../bots";
import type { BotChatHandle } from "../bots";
import type { BotChatPreview, BotSenderChat } from "../contracts";
import { mutation, query, subscription } from "./base";
import { BotId, NoInput } from "./ids";

export const AvatarAccessorySchema = v.optional(
  v.nullable(v.picklist(AVATAR_ACCESSORY_IDS))
);

export const BotChangeNoticeSchema = v.object({
  mission: v.optional(v.boolean()),
  persona: v.optional(v.boolean()),
  checkIn: v.optional(v.string()),
});

/**
 * A notice, independent of any row diff: a transcript-only save changes no
 * bot row but does change what the sidebar previews show.
 */
export type BotsEvent = { type: "previews-changed" };

/** Bot rows and their create/update/delete are the `db.bots` table. */
export const bots = {
  /** Keyed by bot id. */
  chatPreviews: query
    .input(NoInput)
    .output(type<Record<string, BotChatPreview>>()),
  senderChats: query.input(NoInput).output(type<BotSenderChat[]>()),
  /** The bot acknowledges the change in its chat, once. */
  announceChange: mutation
    .input(v.object({ id: BotId, notice: BotChangeNoticeSchema }))
    .output(type<void>()),
  openChat: mutation
    .input(v.object({ botId: BotId }))
    .output(type<BotChatHandle>()),
  events: subscription.input(NoInput).output(eventIterator(type<BotsEvent>())),
};
