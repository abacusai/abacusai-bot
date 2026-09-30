/**
 * A-T1b: every named type the contract (and the renderer transport) imports
 * from a library resolves, from the package that actually exports it, and is
 * not `any`. A wrong package or a missing export fails `tsc -b` here rather
 * than silently widening a procedure to `any`.
 * Sub-slice B adds `@tanstack/db` and `@tanstack/react-db`. (That the real
 * `db.*` client satisfies the collections' table client is checked where the
 * renderer builds them: renderer-next/data/db/tables.ts takes it uncast.)
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
import type {
  ChangeMessageOrDeleteKeyMessage,
  Collection,
  CollectionConfig,
  SyncConfig,
  UtilsRecord,
  createCollection,
} from "@tanstack/db";
import type { useLiveQuery } from "@tanstack/react-db";
import { describe, expectTypeOf, it } from "vitest";

import type { ChatHydrateOptions, ChatHydrationResult } from "./agui";
import type { Contract } from "./index";
import type { SessionRow } from "./rows";

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

  it("resolves every TanStack DB type the collections use", () => {
    expectTypeOf<typeof createCollection>().not.toBeAny();
    expectTypeOf<CollectionConfig<SessionRow, string>>().not.toBeAny();
    expectTypeOf<SyncConfig<SessionRow, string>>().not.toBeAny();
    expectTypeOf<
      ChangeMessageOrDeleteKeyMessage<SessionRow, string>
    >().not.toBeAny();
    expectTypeOf<UtilsRecord>().not.toBeAny();
    expectTypeOf<Collection<SessionRow, string>>().not.toBeAny();
    expectTypeOf<typeof useLiveQuery>().not.toBeAny();
    // `commit()` hands back a visibility receipt (spec 00 B.3).
    expectTypeOf<
      ReturnType<
        Parameters<SyncConfig<SessionRow, string>["sync"]>[0]["commit"]
      >
    >().not.toBeAny();
  });
});
