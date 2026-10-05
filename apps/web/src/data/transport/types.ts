import type { Contract } from "@abacus-ai/contract/contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";

import type { CloseReason } from "./close-signal";
import type { TransportState } from "./lifecycle";

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
   * so a closed transport is never reopened (spec 01 §8.6 step 8). The
   * browser's host transport is `"connecting"` until its first socket opens
   * and `"reconnecting"` between sockets (spec 09 D2); calls made meanwhile
   * wait for the next socket.
   */
  readonly state: TransportState;
  /** +1 per opened channel: always 1 for a port, one per socket on the web. */
  readonly generation: number;
  /** Runs after every state or generation change. Returns an unsubscribe. */
  onChange(listener: () => void): () => void;
  /**
   * The sign-in gate kept its route from fresh host state (spec 09 D12):
   * writes may go out, the held ones first. Which calls are writes is the
   * procedure's kind (`intent.ts`). A port never holds them.
   */
  confirmWrites(ticket?: number): void;
  /**
   * Taken when a gate check starts and passed to `confirmWrites`: a check
   * that started before the last suspension (a replaced socket, a
   * credential change) or revocation confirms nothing.
   */
  writeTicket(): number;
  /**
   * Writes wait again, until the gate confirms or revokes (a replaced
   * socket, a credential change): the gate re-runs from fresh state first.
   */
  suspendWrites(): void;
  /**
   * The gate is leaving its route: every write made so far fails as
   * `HOST_UNAVAILABLE` (not sent), including one already past its wait, and
   * the rest wait for the next `confirmWrites()`.
   */
  revokeWrites(): void;
  /** The close code that ended `generation`, once it has (web only). */
  closeCode?(generation: number): number | undefined;
  /**
   * Called once when the channel closes: `"port-closed"` when the other end
   * went away, `"explicit"` after `close()`. On an already-closed transport
   * the listener runs once on the next microtask. Returns an unsubscribe.
   */
  onClose(listener: (reason: CloseReason) => void): () => void;
  /** Idempotent; reports `"explicit"`. */
  close(): void;
}
