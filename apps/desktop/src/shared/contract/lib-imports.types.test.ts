/**
 * A-T1b: every named type the contract (and the renderer transport) imports
 * from a library resolves, from the package that actually exports it, and is
 * not `any`. A wrong package or a missing export fails `tsc -b` here rather
 * than silently widening a procedure to `any`.
 *
 * `@tanstack/db` is sub-slice B's and is checked there.
 */
import type {
  ClientContext,
  ClientLink,
  ORPCError,
  createORPCClient,
} from "@orpc/client";
import type { RPCLink as MessagePortRPCLink } from "@orpc/client/message-port";
import type { StandardRPCCustomJsonSerializer } from "@orpc/client/standard";
import type { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type {
  ContractRouterClient,
  ErrorFromErrorMap,
  eventIterator,
  oc,
  type,
} from "@orpc/contract";
import type { EventMeta, implement, withEventMeta } from "@orpc/server";
import type { RPCHandler as MessagePortRPCHandler } from "@orpc/server/message-port";
import type { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import type { AsyncIteratorClass } from "@orpc/shared";
import type {
  RouterUtils,
  createTanstackQueryUtils,
} from "@orpc/tanstack-query";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import type {
  RunAgentInputContext,
  RunAgentResumeItem,
  SubscribeConnectionAdapter,
} from "@tanstack/ai-client";
import { describe, expectTypeOf, it } from "vitest";

import type { ChatHydrateOptions, ChatHydrationResult } from "./agui";
import type { Contract } from "./index";

describe("library type imports (A-T1b)", () => {
  it("resolves every AG-UI / TanStack AI type", () => {
    expectTypeOf<StreamChunk>().not.toBeAny();
    expectTypeOf<UIMessage>().not.toBeAny();
    expectTypeOf<RunAgentInputContext>().not.toBeAny();
    expectTypeOf<RunAgentResumeItem>().not.toBeAny();
    expectTypeOf<SubscribeConnectionAdapter>().not.toBeAny();
    expectTypeOf<ChatHydrationResult>().not.toBeAny();
    expectTypeOf<ChatHydrateOptions>().not.toBeAny();
    // The derived hydration result still has the fields ai.hydrate returns.
    expectTypeOf<ChatHydrationResult>().toHaveProperty("messages");
  });

  it("resolves every oRPC type", () => {
    expectTypeOf<ContractRouterClient<Contract>>().not.toBeAny();
    expectTypeOf<ErrorFromErrorMap<Record<never, never>>>().not.toBeAny();
    expectTypeOf<typeof oc>().not.toBeAny();
    expectTypeOf<typeof type>().not.toBeAny();
    expectTypeOf<typeof eventIterator>().not.toBeAny();
    expectTypeOf<typeof implement>().not.toBeAny();
    expectTypeOf<typeof withEventMeta>().not.toBeAny();
    expectTypeOf<EventMeta>().not.toBeAny();
    expectTypeOf<typeof createORPCClient>().not.toBeAny();
    expectTypeOf<ClientLink<ClientContext>>().not.toBeAny();
    expectTypeOf<ORPCError<string, unknown>>().not.toBeAny();
    expectTypeOf<MessagePortRPCHandler<object>>().not.toBeAny();
    expectTypeOf<MessagePortRPCLink<ClientContext>>().not.toBeAny();
    expectTypeOf<WebSocketRPCHandler<object>>().not.toBeAny();
    expectTypeOf<WebSocketRPCLink<ClientContext>>().not.toBeAny();
    expectTypeOf<StandardRPCCustomJsonSerializer>().not.toBeAny();
    expectTypeOf<AsyncIteratorClass<unknown>>().not.toBeAny();
    expectTypeOf<typeof createTanstackQueryUtils>().not.toBeAny();
    expectTypeOf<RouterUtils<ContractRouterClient<Contract>>>().not.toBeAny();
  });
});
