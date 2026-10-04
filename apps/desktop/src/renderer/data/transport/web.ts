/**
 * The hosted web app's transport: the same client over a WebSocket to its
 * server (lib/web-app.ts picks the URL), one per document, kept on a global
 * symbol like `getTransport()` so a Vite HMR re-run reuses it.
 */
import { webSocketUrl } from "#renderer/lib/web-app";

import type { Transport } from "./types";
import { createWebSocketTransport } from "./websocket";

const GLOBAL_KEY = Symbol.for("abacus.transport.web");

type TransportGlobal = { [GLOBAL_KEY]?: Promise<Transport> };

export const getWebTransport = (): Promise<Transport> => {
  const store = globalThis as TransportGlobal;
  store[GLOBAL_KEY] ??= Promise.resolve(
    createWebSocketTransport(webSocketUrl())
  );
  return store[GLOBAL_KEY];
};
