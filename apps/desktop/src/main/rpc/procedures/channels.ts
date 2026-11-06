import type { ChannelsEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const channelsRouter = impl.channels.router({
  list: impl.channels.list.handler(({ context }) =>
    context.deps.serviceHost.listChannels()
  ),
  thread: impl.channels.thread.handler(({ input, context }) =>
    context.deps.serviceHost.channelThread(input.channelId)
  ),
  create: impl.channels.create.handler(({ input, context }) =>
    context.deps.serviceHost.createChannel(input)
  ),
  update: impl.channels.update.handler(({ input, context }) =>
    context.deps.serviceHost.updateChannel(input.channelId, {
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.about != null ? { about: input.about } : {}),
      ...(input.botIds != null ? { botIds: input.botIds } : {}),
    })
  ),
  remove: impl.channels.remove.handler(({ input, context }) =>
    context.deps.serviceHost.removeChannel(input.channelId)
  ),
  post: impl.channels.post.handler(({ input, context }) =>
    context.deps.serviceHost.postToChannel(
      input.channelId,
      input.text,
      input.replyTo
    )
  ),
  pin: impl.channels.pin.handler(({ input, context }) =>
    context.deps.serviceHost.pinInChannel(input.channelId, {
      ...(input.text != null ? { text: input.text } : {}),
      ...(input.messageId != null ? { messageId: input.messageId } : {}),
    })
  ),
  unpin: impl.channels.unpin.handler(({ input, context }) =>
    context.deps.serviceHost.unpinInChannel(input.channelId, input.decisionId)
  ),
  startAgreed: impl.channels.startAgreed.handler(({ input, context }) =>
    context.deps.serviceHost.startAgreedInChannel(
      input.channelId,
      input.messageId
    )
  ),
  decideProposal: impl.channels.decideProposal.handler(({ input, context }) =>
    context.deps.serviceHost.decideChannelProposal(
      input.channelId,
      input.messageId,
      input.create
    )
  ),
  stopAll: impl.channels.stopAll.handler(({ input, context }) =>
    context.deps.serviceHost.stopChannel(input.channelId)
  ),
  // Coarse: the list and the open thread refetch on any change.
  events: impl.channels.events.handler(({ context, signal }) =>
    stream<ChannelsEvent>({
      path: "channels.events",
      context,
      signal,
      attach: onIpcEvents(context, isType("channels-updated"), (event) =>
        event.type === "channels-updated"
          ? { type: "changed" as const, channelId: event.channelId }
          : null
      ),
      coalesceKey: (event) => `${event.type}:${event.channelId ?? ""}`,
    })
  ),
});
