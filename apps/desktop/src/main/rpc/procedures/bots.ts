import type { BotsEvent } from "#shared/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const botsRouter = impl.bots.router({
  chatPreviews: impl.bots.chatPreviews.handler(({ context }) =>
    context.deps.serviceHost.listBotChatPreviews()
  ),
  senderChats: impl.bots.senderChats.handler(({ context }) =>
    context.deps.serviceHost.listBotSenderChats()
  ),
  announceChange: impl.bots.announceChange.handler(({ input, context }) =>
    context.deps.serviceHost.announceBotChange(input.id, input.notice)
  ),
  openChat: impl.bots.openChat.handler(({ input, context }) =>
    context.deps.serviceHost.openBotChat(input.botId)
  ),
  // Every legacy `bots-updated`, including transcript-only saves that change
  // no bot row, is a previews notice.
  events: impl.bots.events.handler(({ context, signal }) =>
    stream<BotsEvent>({
      path: "bots.events",
      context,
      signal,
      attach: onIpcEvents(context, isType("bots-updated"), () => ({
        type: "previews-changed" as const,
      })),
      coalesceKey: (event) => event.type,
    })
  ),
});
