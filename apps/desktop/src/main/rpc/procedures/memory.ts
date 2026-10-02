import type { MemoryEvent } from "#shared/contract";

import { impl, onChannel, stream } from "./impl";

export const memoryRouter = impl.memory.router({
  customInstructions: {
    get: impl.memory.customInstructions.get.handler(({ context }) =>
      context.deps.host.getCustomInstructions()
    ),
    set: impl.memory.customInstructions.set.handler(({ input, context }) =>
      context.deps.host.setCustomInstructions(input.text)
    ),
  },
  forgetAll: impl.memory.forgetAll.handler(({ input, context }) =>
    context.deps.serviceHost.forgetAllMemories(input.target)
  ),
  bots: impl.memory.bots.handler(({ context }) =>
    context.deps.serviceHost.listBotMemories()
  ),
  clearBot: impl.memory.clearBot.handler(({ input, context }) =>
    context.deps.serviceHost.clearBotMemory(input.botId)
  ),
  // Published by the memory watchers (sub-slice B); nothing publishes yet.
  events: impl.memory.events.handler(({ context, signal }) =>
    stream<MemoryEvent>({
      path: "memory.events",
      context,
      signal,
      attach: onChannel(context, "memory", (payload) => payload),
      coalesceKey: (event) => event.type,
    })
  ),
});
