/**
 * `ChatRuntime` (spec 02 §2, §3.1): the per-document cache of
 * `ThreadSession`s (an LRU of 8; a session with a mounted view is pinned),
 * kept on `globalThis` so Fast Refresh keeps streams, plus the commands
 * views call by thread. Router context member once the foundation adds it;
 * until then `chatRuntimeFor(transport)` returns the document's one.
 */
import type { AiClient } from "#next/data/ai";
import type { Transport } from "#next/data/transport";
import type { PermissionDecision } from "#shared/agent-types";

import type { PermissionDescriptor } from "../store/thread-store";
import {
  hostActionsFor,
  inertHostActions,
  type ChatHostActions,
} from "./host-actions";
import { ThreadSession, type ThreadSessionOptions } from "./session";

export const MAX_CACHED_THREADS = 8;

export interface ChatRuntime {
  session(threadId: string): ThreadSession;
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
  host?: ChatHostActions;
}

export const createChatRuntime = (
  ai: AiClient,
  options: ChatRuntimeOptions = {}
): ChatRuntime => {
  const sessions = new Map<string, ThreadSession>();
  const capacity = options.capacity ?? MAX_CACHED_THREADS;

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
    evict();
    return created;
  };

  return {
    session,
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

/** The document's runtime for a transport; survives Fast Refresh (§3.1). */
export const chatRuntimeFor = (transport: Transport): ChatRuntime => {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = (holder[KEY] ??= new WeakMap());
  let runtime = registry.get(transport.client);
  if (runtime == null) {
    runtime = createChatRuntime(transport.client.ai, {
      host: hostActionsFor(transport),
    });
    registry.set(transport.client, runtime);
  }
  return runtime;
};
