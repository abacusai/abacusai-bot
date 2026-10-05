import type { AiClient } from "#renderer/data/ai";

import type { ChatRuntime, ChatRuntimeOptions } from "./runtime";

/** An idle companion needs attention events, but no transcript processor yet. */
export const createLazyChatRuntime = (
  ai: AiClient,
  options: ChatRuntimeOptions,
  load = () => import("./runtime")
): { chat: ChatRuntime; prepareChat(): Promise<void> } => {
  let runtime: ChatRuntime | null = null;
  let pending: Promise<void> | null = null;
  const prepareChat = (): Promise<void> => {
    pending ??= load()
      .then((module) => {
        runtime = module.createChatRuntime(ai, options);
      })
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  };
  const ready = (): ChatRuntime => {
    if (!runtime)
      throw new Error(
        "Chat runtime must be prepared before presenting a thread"
      );
    return runtime;
  };
  return {
    prepareChat,
    chat: {
      session: (id) => ready().session(id),
      peek: (id) => runtime?.peek(id),
      get host() {
        return ready().host;
      },
      respondPermission: async (...args) => {
        await prepareChat();
        return ready().respondPermission(...args);
      },
      cancel: async (id) => {
        await prepareChat();
        return ready().cancel(id);
      },
      forget: (id) => runtime?.forget(id),
      queue: {
        enqueue: async (...args) => {
          await prepareChat();
          return ready().queue.enqueue(...args);
        },
        update: async (...args) => {
          await prepareChat();
          return ready().queue.update(...args);
        },
        remove: async (...args) => {
          await prepareChat();
          return ready().queue.remove(...args);
        },
        clear: async (...args) => {
          await prepareChat();
          return ready().queue.clear(...args);
        },
      },
    },
  };
};
