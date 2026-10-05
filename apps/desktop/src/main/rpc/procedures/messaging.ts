import type { MessagingEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const messagingRouter = impl.messaging.router({
  snapshot: impl.messaging.snapshot.handler(({ context }) =>
    context.deps.serviceHost.getMessagingSnapshot()
  ),
  updatePlatform: impl.messaging.updatePlatform.handler(({ input, context }) =>
    context.deps.serviceHost.updateMessagingPlatform(input)
  ),
  decidePairing: impl.messaging.decidePairing.handler(({ input, context }) =>
    context.deps.serviceHost.decideMessagingPairing(input)
  ),
  updateSettings: impl.messaging.updateSettings.handler(({ input, context }) =>
    context.deps.serviceHost.updateMessagingSettings(input)
  ),
  showLogin: impl.messaging.showLogin.handler(({ input, context }) => {
    context.deps.serviceHost.showMessagingLogin(input.platformId);
  }),
  pairShared: impl.messaging.pairShared.handler(({ input, context }) =>
    context.deps.serviceHost.pairSharedChannel(input.platformId)
  ),
  unlinkShared: impl.messaging.unlinkShared.handler(({ input, context }) =>
    context.deps.serviceHost.unlinkSharedChannel(input.platformId)
  ),
  openSharedLink: impl.messaging.openSharedLink.handler(
    async ({ input, context }) => {
      await context.deps.serviceHost.openSharedChannelLink(
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
