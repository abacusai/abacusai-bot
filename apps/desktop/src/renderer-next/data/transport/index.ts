/**
 * The renderer's one way to reach main (spec 00 A.7). `getTransport()` asks
 * the preload for this document's port once; the promise lives on a global
 * symbol, so a Vite HMR re-run of this module reuses it instead of asking
 * again (the preload would refuse a second request anyway).
 */
import { connectMessagePortTransport } from "./message-port";
import type { Transport } from "./types";

const GLOBAL_KEY = Symbol.for("abacus.transport");

type TransportGlobal = { [GLOBAL_KEY]?: Promise<Transport> };

export const getTransport = (): Promise<Transport> => {
  const store = globalThis as TransportGlobal;
  store[GLOBAL_KEY] ??= connectMessagePortTransport();
  return store[GLOBAL_KEY];
};

// The factory itself, for tests that build a transport over their own port
// (the Electron handshake test, spec 00 A-T12).
export { createTransport } from "./create-transport";
export type { CreateTransportOptions, TransportPort } from "./create-transport";
export type { CloseReason } from "./close-signal";
export type { AppQueryUtils, Transport } from "./types";
