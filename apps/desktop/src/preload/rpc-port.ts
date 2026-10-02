/**
 * The preload half of the oRPC port handshake (spec 00 A.4.4).
 *
 * The page asks for a port by posting `{ type: "abacus:rpc-connect", nonce }`
 * to its own window. The first such request in a document gets a fresh
 * MessageChannel: one end goes to main (`rpc:connect`), the other back to the
 * page with the same nonce. Every later request in the same document is
 * answered `already-connected`, with no port, so a document never holds two.
 * The preload runs again for every document, so a reload starts over.
 *
 * This is Electron's documented way to hand a port to the main world of a
 * context-isolated page: the page never sees `ipcRenderer`.
 */
import type { IpcRenderer } from "electron";

export const RPC_CONNECT_REQUEST = "abacus:rpc-connect";
export const RPC_PORT_RESPONSE = "abacus:rpc-port";
export const RPC_CONNECT_CHANNEL = "rpc:connect";

/** The window surface the handshake uses (the preload compiles without DOM types). */
export interface HandshakeMessageEvent {
  source: unknown;
  data: unknown;
}

export interface HandshakeWindow {
  addEventListener(
    type: "message",
    listener: (event: HandshakeMessageEvent) => void
  ): void;
  postMessage(
    message: unknown,
    targetOrigin: string,
    transfer?: unknown[]
  ): void;
}

export interface RpcPortHandshakeOptions {
  /**
   * Holds the page's half back this long (main's half goes at once). Only the
   * real-Electron test's own preload entry passes it (from
   * ABACUS_TEST_HANDSHAKE_DELAY_MS), to make the page time out and close a
   * late port; the shipped preload (index.ts) never does.
   */
  delayMs?: number;
}

export const installRpcPortHandshake = (
  ipcRenderer: Pick<IpcRenderer, "postMessage">,
  win: HandshakeWindow,
  kind: "main" | "notch",
  options: RpcPortHandshakeOptions = {}
): void => {
  let answered = false;

  win.addEventListener("message", (event) => {
    // Only this window's own posts; `"*"` below is safe for the same reason.
    if (event.source !== win) return;
    const data = event.data as { type?: unknown; nonce?: unknown } | null;
    if (data?.type !== RPC_CONNECT_REQUEST || typeof data.nonce !== "string")
      return;

    if (answered) {
      // A duplicate or late request: answered, but never with a second port.
      win.postMessage(
        {
          type: RPC_PORT_RESPONSE,
          nonce: data.nonce,
          error: "already-connected",
        },
        "*"
      );
      return;
    }
    answered = true;

    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage(RPC_CONNECT_CHANNEL, { kind }, [port1]);
    const hand = (): void =>
      win.postMessage({ type: RPC_PORT_RESPONSE, nonce: data.nonce }, "*", [
        port2,
      ]);
    if ((options.delayMs ?? 0) > 0) setTimeout(hand, options.delayMs);
    else hand();
  });
};

/** The test-only delay, read from the environment the preload runs in. */
export const handshakeDelayFromEnv = (
  env: Record<string, string | undefined>
): number => {
  const raw = Number(env.ABACUS_TEST_HANDSHAKE_DELAY_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
};
