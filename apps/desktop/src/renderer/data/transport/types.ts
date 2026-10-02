import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";

import type { Contract } from "#shared/contract";

import type { CloseReason, TransportState } from "./close-signal";

/** The typed oRPC client for the whole contract. */
export type AppClient = ContractRouterClient<Contract>;

/** `@orpc/tanstack-query` utilities over it: `orpc.x.y.queryOptions()`, `.key()`… */
export type AppQueryUtils = RouterUtils<AppClient>;

export type TransportKind = "message-port" | "websocket" | "memory";

/** What the preload exposes besides the port (`window.abacusHost`). */
export interface TransportHost {
  getPathForFile?: (file: File) => string;
}

/**
 * Everything the renderer knows about main. No Electron: a port, a socket or
 * an in-process channel are all the same to the code above this.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly client: AppClient;
  readonly orpc: AppQueryUtils;
  readonly host: TransportHost;
  /**
   * `"closed"` once the channel is gone, for good: a document gets one port,
   * so a closed transport is never reopened (spec 01 §8.6 step 8).
   */
  readonly state: TransportState;
  /**
   * Called once when the channel closes: `"port-closed"` when the other end
   * went away, `"explicit"` after `close()`. On an already-closed transport
   * the listener runs once on the next microtask. Returns an unsubscribe.
   */
  onClose(listener: (reason: CloseReason) => void): () => void;
  /** Idempotent; reports `"explicit"`. */
  close(): void;
}
