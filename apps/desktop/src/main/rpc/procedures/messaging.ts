import type { MessagingEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const messagingRouter = impl.messaging.router({
  snapshot: impl.messaging.snapshot.handler(({ context }) =>
    context.deps.serviceHost.getMessagingSnapshot()
  ),
  updatePlatform: impl.messaging.updatePlatform.handler(({ input, context }) =>
    context.deps.serviceHost.updateMessagingPlatform(input)
  ),
  unlinkPlatform: impl.messaging.unlinkPlatform.handler(({ input, context }) =>
    context.deps.serviceHost.unlinkMessagingPlatform(input.platformId)
  ),
  decidePairing: impl.messaging.decidePairing.handler(({ input, context }) =>
    context.deps.serviceHost.decideMessagingPairing(input)
  ),
  updateSettings: impl.messaging.updateSettings.handler(({ input, context }) =>
    context.deps.serviceHost.updateMessagingSettings(input)
  ),
  setHomeBot: impl.messaging.setHomeBot.handler(({ input, context }) =>
    context.deps.serviceHost.setMessagingHomeBot(input.platformId, input.botId)
  ),
  showLogin: impl.messaging.showLogin.handler(({ input, context }) => {
    context.deps.serviceHost.showMessagingLogin(input.platformId);
  }),
  releaseLogin: impl.messaging.releaseLogin.handler(({ input, context }) => {
    context.deps.serviceHost.releaseMessagingLogin(input.platformId);
  }),
  pairShared: impl.messaging.pairShared.handler(({ input, context }) =>
    context.deps.serviceHost.pairSharedChannel(input.platformId)
  ),
  unlinkShared: impl.messaging.unlinkShared.handler(({ input, context }) =>
    context.deps.serviceHost.unlinkSharedChannel(input.platformId)
  ),
  openSharedLink: impl.messaging.openSharedLink.handler(
    async ({ input, context }) => {
      return context.deps.serviceHost.openSharedChannelLink(
        input.platformId,
        input.target
      );
    }
  ),
  events: impl.messaging.events.handler(({ context, signal }) =>
    stream<MessagingEvent>({
      path: "messaging.events",
      context,
      signal,
      attach: onIpcEvents(context, isType("messaging-updated"), () => ({
        type: "updated" as const,
      })),
      coalesceKey: (event) => event.type,
    })
  ),
});
