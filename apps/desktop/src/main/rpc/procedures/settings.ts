import type { SettingsEvent } from "#shared/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const settingsRouter = impl.settings.router({
  get: impl.settings.get.handler(({ context }) =>
    context.deps.host.readSettings()
  ),
  promptHistory: {
    list: impl.settings.promptHistory.list.handler(({ input, context }) =>
      context.deps.host.readPromptHistory(input.scope)
    ),
    add: impl.settings.promptHistory.add.handler(({ input, context }) =>
      context.deps.host.addPromptToHistory(input.scope, input.prompt)
    ),
  },
  keys: {
    listProviders: impl.settings.keys.listProviders.handler(({ context }) =>
      context.deps.host.storedKeyProviders()
    ),
    save: impl.settings.keys.save.handler(({ input, context }) =>
      context.deps.host.saveApiKey(input.provider, input.key)
    ),
  },
  setDefaultModel: impl.settings.setDefaultModel.handler(({ input, context }) =>
    context.deps.host.setDefaultModel(input.modelId)
  ),
  toolsets: {
    get: impl.settings.toolsets.get.handler(({ context }) =>
      context.deps.serviceHost.getToolsetStates()
    ),
    setEnabled: impl.settings.toolsets.setEnabled.handler(
      ({ input, context }) =>
        context.deps.serviceHost.setToolsetEnabled(
          input.toolsetId,
          input.enabled
        )
    ),
  },
  defaultMode: {
    get: impl.settings.defaultMode.get.handler(({ context }) =>
      context.deps.serviceHost.getDefaultAgentMode()
    ),
    set: impl.settings.defaultMode.set.handler(({ input, context }) =>
      context.deps.serviceHost.setDefaultAgentMode(input.mode)
    ),
  },
  sandboxSupport: impl.settings.sandboxSupport.handler(({ context }) =>
    context.deps.serviceHost.getSandboxSupport()
  ),
  notifications: {
    get: impl.settings.notifications.get.handler(({ context }) =>
      context.deps.serviceHost.getNotificationSettings()
    ),
    set: impl.settings.notifications.set.handler(({ input, context }) =>
      context.deps.serviceHost.setNotificationSettings(input)
    ),
  },
  execBackend: {
    get: impl.settings.execBackend.get.handler(({ context }) =>
      context.deps.serviceHost.getExecBackendState()
    ),
    set: impl.settings.execBackend.set.handler(({ input, context }) =>
      context.deps.serviceHost.setExecBackend(input.backend)
    ),
  },
  // The only destination for a credential change: a save or a removal.
  events: impl.settings.events.handler(({ context, signal }) =>
    stream<SettingsEvent>({
      path: "settings.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType("credentials-changed"),
        (event): SettingsEvent | null =>
          event.type === "credentials-changed"
            ? {
                type: "credentials-changed",
                provider: event.provider,
                ...(event.configured == null
                  ? {}
                  : { configured: event.configured }),
              }
            : null
      ),
      coalesceKey: (event) => `credentials-changed:${event.provider}`,
    })
  ),
});
