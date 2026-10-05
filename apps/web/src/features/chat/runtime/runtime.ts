import type { PermissionDecision } from "@abacus-ai/contract/agent-types";
/**
 * `ChatRuntime` (spec 02 §2, §3.1): the per-document cache of
 * `ThreadSession`s (an LRU of 8; a session with a mounted view is pinned),
 * kept on `globalThis` so Fast Refresh keeps streams, plus the commands
 * views call by thread. Router context member once the foundation adds it;
 * until then `chatRuntimeFor(transport)` returns the document's one.
 */
import type { AiHydration } from "@abacus-ai/contract/contract/ai";
import type { QueryClient } from "@tanstack/react-query";

import type { AiClient } from "#renderer/data/ai";
import type { Transport } from "#renderer/data/transport";

import type { PermissionDescriptor } from "../store/thread-store";
import {
  hostActionsFor,
  inertHostActions,
  type ChatHostActions,
} from "./host-actions";
import { PAGE_SIZE, ThreadSession, type ThreadSessionOptions } from "./session";

const MAX_CACHED_THREADS = 8;

export interface ChatRuntime {
  session(threadId: string): ThreadSession;
  /** The cached session, if any: creates none and leaves the LRU order. */
  peek(threadId: string): ThreadSession | undefined;
  /** Links, pickers, pasted files (§7.5, §8.6). */
  readonly host: ChatHostActions;
  respondPermission(
    threadId: string,
    descriptor: PermissionDescriptor,
    decision: PermissionDecision
  ): Promise<void>;
  queue: {
    enqueue(threadId: string, text: string): Promise<void>;
    update(threadId: string, entryId: string, text: string): Promise<void>;
    remove(threadId: string, entryId: string): Promise<void>;
    clear(threadId: string): Promise<void>;
  };
  cancel(threadId: string): Promise<void>;
  /** Drops a deleted thread's session (its view is gone). */
  forget(threadId: string): void;
}

export interface ChatRuntimeOptions {
  sessionOptions?: Omit<ThreadSessionOptions, "ai" | "threadId">;
  capacity?: number;
  maxSessions?: number;
  host?: ChatHostActions;
}

export const createChatRuntime = (
  ai: AiClient,
  options: ChatRuntimeOptions = {}
): ChatRuntime => {
  const sessions = new Map<string, ThreadSession>();
  const capacity =
    options.maxSessions ?? options.capacity ?? MAX_CACHED_THREADS;

  const evict = (): void => {
    for (const [threadId, session] of sessions) {
      if (sessions.size <= capacity) return;
      if (session.pinned) continue;
      sessions.delete(threadId);
      session.retire();
    }
  };

  const session = (threadId: string): ThreadSession => {
    let found = sessions.get(threadId);
    if (found != null && found.retired) {
      sessions.delete(threadId);
      found = undefined;
    }
    if (found != null) {
      // Most recently used last.
      sessions.delete(threadId);
      sessions.set(threadId, found);
      return found;
    }
    const created = new ThreadSession({
      ai,
      threadId,
      ...options.sessionOptions,
      log:
        options.sessionOptions?.log ??
        ((message, error) => console.warn(`[chat] ${message}`, error)),
    });
    sessions.set(threadId, created);
    queueMicrotask(evict);
    return created;
  };

  return {
    session,
    peek: (threadId) => {
      const found = sessions.get(threadId);
      return found?.retired === false ? found : undefined;
    },
    host: options.host ?? inertHostActions,
    respondPermission: (threadId, descriptor, decision) =>
      session(threadId).respondPermission(descriptor, decision),
    queue: {
      enqueue: (threadId, text) => session(threadId).enqueue(text),
      update: (threadId, entryId, text) =>
        session(threadId).updateQueued(entryId, text),
      remove: (threadId, entryId) => session(threadId).removeQueued(entryId),
      clear: (threadId) => session(threadId).clearQueue(),
    },
    cancel: (threadId) => session(threadId).cancel(),
    forget: (threadId) => {
      sessions.get(threadId)?.retire();
      sessions.delete(threadId);
    },
  };
};

const KEY = Symbol.for("abacus.chat.sessions");
type Registry = WeakMap<object, ChatRuntime>;

/**
 * The document's runtime for a transport; survives Fast Refresh (§3.1).
 * `credentialsChanged` (from the router, which creates it first) is what a
 * host action calls after it changed a credential.
 */
export const chatRuntimeFor = (
  transport: Transport,
  credentialsChanged?: () => Promise<unknown>
): ChatRuntime => {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = (holder[KEY] ??= new WeakMap());
  let runtime = registry.get(transport.client);
  if (runtime == null) {
    runtime = createChatRuntime(transport.client.ai, {
      host: hostActionsFor(transport, credentialsChanged),
    });
    registry.set(transport.client, runtime);
  }
  return runtime;
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
  load: (threadId: string): Promise<void> =>
    context.chat.session(threadId).load({
      seed: (signal) =>
        takeWarm(context.queryClient, context.transport, threadId, signal),
    }),
});
