import type { AiHydration } from "@abacus-ai/contract/contract/ai";
import type { QueryClient } from "@tanstack/react-query";

import type { AiClient } from "#renderer/data/ai";
import type { Transport } from "#renderer/data/transport";

import { PAGE_SIZE } from "./page-size";
import type { ChatRuntime, ChatRuntimeOptions } from "./runtime";

type RuntimeModule = typeof import("./runtime");

export interface LazyChatRuntime {
  chat: ChatRuntime;
  /** Loads the runtime's code; `chat.session()` needs it first. */
  prepareChat(): Promise<void>;
}

/**
 * The chat runtime behind a getter: its code (the transcript processor,
 * `@tanstack/ai*`) loads on first use, not with the app's entry. An idle
 * companion needs attention events, but no transcript processor yet.
 */
export const createLazyChatRuntime = (
  ai: AiClient,
  options: ChatRuntimeOptions,
  load: () => Promise<RuntimeModule> = () => import("./runtime"),
  build = (module: RuntimeModule): ChatRuntime =>
    module.createChatRuntime(ai, options)
): LazyChatRuntime => {
  let runtime: ChatRuntime | null = null;
  let pending: Promise<void> | null = null;
  const prepareChat = (): Promise<void> => {
    pending ??= load()
      .then((module) => {
        runtime = build(module);
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

const KEY = Symbol.for("abacus.chat.lazy");
type Registry = WeakMap<object, LazyChatRuntime>;

/** The document's runtime for a transport (`chatRuntimeFor`), loaded lazily. */
export const lazyChatRuntimeFor = (
  transport: Transport,
  credentialsChanged?: () => Promise<unknown>
): LazyChatRuntime => {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = (holder[KEY] ??= new WeakMap());
  let lazy = registry.get(transport.client);
  if (lazy == null) {
    lazy = createLazyChatRuntime(
      transport.client.ai,
      {},
      () => import("./runtime"),
      (module) => module.chatRuntimeFor(transport, credentialsChanged)
    );
    registry.set(transport.client, lazy);
  }
  return lazy;
};

/**
 * Hover warming for chat routes. A hover on a chat the runtime does not
 * already hold live or loading fetches the thread's first `ai.hydrate` page
 * into the query cache and creates no `ThreadSession` (a session that
 * finishes loading keeps a live `ai.subscribe` stream in the runtime's
 * cache). The click's loader hands `session.load` a seed: a new generation
 * takes that page, fresh or still in flight, inside its own ready cap and
 * abort signal, so a slow hover request delays the click no longer than a
 * hydrate of its own would; the session then skips its own hydrate and
 * subscribes from the page's cursor. A page is used once, then dropped;
 * `WARM_MS` is how old it may be and still seed a session.
 */
const WARM_MS = 15_000;

const hydrateQuery = (transport: Transport, threadId: string) =>
  transport.orpc.ai.hydrate.queryOptions({
    input: { threadId, limit: PAGE_SIZE },
    staleTime: WARM_MS,
    // Unused after the window: no point keeping the transcript around.
    gcTime: WARM_MS,
  });

const takeWarm = async (
  queryClient: QueryClient,
  transport: Transport,
  threadId: string,
  signal: AbortSignal
): Promise<AiHydration | undefined> => {
  const options = hydrateQuery(transport, threadId);
  const state = queryClient.getQueryState(options.queryKey);
  if (state == null) return undefined;
  const usable =
    state.fetchStatus === "fetching" ||
    (state.data !== undefined && Date.now() - state.dataUpdatedAt < WARM_MS);
  try {
    if (!usable) return undefined;
    return await new Promise<AiHydration | undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
      queryClient.fetchQuery(options).then(resolve, () => resolve(undefined));
    });
  } finally {
    queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
  }
};

/**
 * `warm` for a hover, `load` for the click, `ready` when there is nothing
 * left to load: what chat loaders call.
 */
export const chatLoading = (context: {
  chat: Pick<ChatRuntime, "session" | "peek">;
  prepareChat(): Promise<void>;
  queryClient: QueryClient;
  transport: Transport;
}) => ({
  warm: (threadId: string): void => {
    // A live or loading session has its transcript already.
    if (context.chat.peek(threadId)?.started === true) return;
    void context.queryClient.prefetchQuery(
      hydrateQuery(context.transport, threadId)
    );
  },
  ready: (threadId: string): boolean =>
    context.chat.peek(threadId)?.ready === true,
  load: async (threadId: string): Promise<void> => {
    await context.prepareChat();
    return context.chat.session(threadId).load({
      seed: (signal) =>
        takeWarm(context.queryClient, context.transport, threadId, signal),
    });
  },
});
