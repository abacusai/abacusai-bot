/**
 * The spec's "memory transport" (spec 02 §13): main's own `ai.*` procedures
 * (`main/rpc/procedures/ai.ts`) behind the real `RPCHandler`/`RPCLink` over a
 * `MessageChannel` (`createMemoryTransport`), serving an `AguiSource` from
 * the test: the fixture relay, or main's real `AguiRelayService` (see
 * `real-host.ts`).
 *
 * Main is loaded through a specifier the compiler does not follow: the
 * renderer program is typed without Node or Electron and cannot
 * compile main's sources (spec 01 §3.4), while vitest runs them fine. What
 * is used from main is restated as the narrow types below.
 */
import type { Router } from "@orpc/server";

import type { AiClient } from "#renderer/data/ai";
import {
  createMemoryTransport,
  type MemoryTransport,
} from "#renderer/data/transport/memory";
import type { AguiSourceLike } from "#renderer/features/chat/fixtures/ai-router";
import {
  FakeRelay,
  type FakeRelayOptions,
} from "#renderer/features/chat/fixtures/relay";

/** Loads a main (or agent) module by a path the type checker ignores. */
export const loadUntyped = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

const MAIN_AI_ROUTER = "#main/rpc/procedures/ai";

let mainAiRouter: Router<any, any> | null = null;

/** Main's `aiRouter`, as the app mounts it under `ai`. */
const loadMainAiRouter = async (): Promise<Router<any, any>> => {
  mainAiRouter ??= (
    await loadUntyped<{ aiRouter: Router<any, any> }>(MAIN_AI_ROUTER)
  ).aiRouter;
  return mainAiRouter;
};

export interface MemoryAi {
  ai: AiClient;
  transport: MemoryTransport;
}

/** `ai.*` over the memory transport, served by main's router over `source`. */
export const memoryAi = async (source: AguiSourceLike): Promise<MemoryAi> => {
  const router = await loadMainAiRouter();
  const transport = createMemoryTransport(
    { ai: router },
    { deps: { ai: source } }
  );
  return { ai: transport.client.ai, transport };
};

const open: MemoryTransport[] = [];

/**
 * A fixture relay whose `relay.ai` is main's router over the memory
 * transport. `closeMemoryRelays()` closes every transport opened so far.
 */
export const memoryRelay = async (
  options: Omit<FakeRelayOptions, "connect"> = {}
): Promise<FakeRelay> => {
  const router = await loadMainAiRouter();
  return new FakeRelay({
    ...options,
    connect: (source) => {
      const transport = createMemoryTransport(
        { ai: router },
        { deps: { ai: source } }
      );
      open.push(transport);
      return transport.client.ai;
    },
  });
};

export const closeMemoryRelays = (): void => {
  for (const transport of open.splice(0)) transport.close();
};
