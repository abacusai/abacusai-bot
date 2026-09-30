import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";

import type { Contract } from "#shared/contract";

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
  close(): void;
}
