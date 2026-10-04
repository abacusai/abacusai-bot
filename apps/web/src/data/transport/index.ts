import { browserConnection } from "#renderer/features/shell/connect/services";
import { IS_ELECTRON } from "#renderer/lib/platform";

/**
 * The renderer's one way to reach main (spec 00 A.7). `getTransport()` asks
 * the preload for this document's port once; the promise lives on a global
 * symbol, so a Vite HMR re-run of this module reuses it instead of asking
 * again (the preload would refuse a second request anyway).
 */
import { connectMessagePortTransport } from "./message-port";
import type { Transport } from "./types";
import { connectWebSocketTransport } from "./websocket";

const GLOBAL_KEY = Symbol.for("abacus.transport");

type TransportGlobal = { [GLOBAL_KEY]?: Promise<Transport> };

export const getTransport = (): Promise<Transport> => {
  const store = globalThis as TransportGlobal;
  store[GLOBAL_KEY] ??= IS_ELECTRON
    ? connectMessagePortTransport()
    : connectWebSocketTransport(browserConnection().url, [
        "abacus-rpc",
        `abacus-token.${browserConnection().token}`,
      ]).catch((error: unknown) => {
        delete store[GLOBAL_KEY];
        throw error;
      });
  return store[GLOBAL_KEY];
};

/**
 * The factory itself, for tests that build a transport over their own port:
 * the Electron handshake test (spec 00 A-T12, `src/main/rpc/transports/
 * rpc-handshake.electron.test.ts`) imports this file by path inside the
 * renderer it spawns, which knip (scoped to renderer) cannot see.
 * @public
 */
export { createTransport } from "./create-transport";
export type { CloseReason } from "./close-signal";
export type { AppQueryUtils, Transport } from "./types";
