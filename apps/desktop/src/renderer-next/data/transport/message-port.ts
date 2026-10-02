/**
 * The renderer half of the port handshake (spec 00 A.4.4): post a nonce to
 * our own window, receive a MessagePort from the preload with the same nonce.
 *
 * Nothing to retry: the preload's listener exists before any page script runs
 * and ours exists before we post, so a request cannot be lost. A document
 * gets one port; a second request is refused by the preload. A port that
 * arrives after the timeout, or for a nonce we are not waiting on, is closed
 * on arrival, which closes main's end too.
 */
import { createTransport } from "./create-transport";
import type { Transport, TransportHost } from "./types";

export const RPC_CONNECT_REQUEST = "abacus:rpc-connect";
export const RPC_PORT_RESPONSE = "abacus:rpc-port";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** No port came: the preload is missing, crashed, or refused a second one. */
export class TransportUnavailableError extends Error {
  constructor(readonly reason: "timeout" | "already-connected" | string) {
    super(`The main-process transport is unavailable (${reason})`);
    this.name = "TransportUnavailableError";
  }
}

/** The window surface the handshake uses. */
export type HandshakeWindow = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "postMessage"
> & { abacusHost?: TransportHost };

export interface ConnectOptions {
  win?: HandshakeWindow;
  timeoutMs?: number;
  /** For tests; `crypto.randomUUID()` otherwise. */
  nonce?: () => string;
}

const closePorts = (event: MessageEvent): void => {
  for (const port of event.ports) port.close();
};

/** Ask the preload for this document's port. */
export const requestRpcPort = ({
  win = window,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  nonce: makeNonce = () => crypto.randomUUID(),
}: ConnectOptions = {}): Promise<MessagePort> => {
  const nonce = makeNonce();
  let settled = false;

  return new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TransportUnavailableError("timeout"));
    }, timeoutMs);

    // Stays for the document's life: a late answer still has its port closed.
    win.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== win) return;
      const data = event.data as {
        type?: unknown;
        nonce?: unknown;
        error?: unknown;
      } | null;
      if (data?.type !== RPC_PORT_RESPONSE) return;

      if (settled || data.nonce !== nonce) {
        closePorts(event);
        return;
      }
      settled = true;
      clearTimeout(timer);

      const [port] = event.ports;
      if (typeof data.error === "string" || port == null) {
        closePorts(event);
        reject(
          new TransportUnavailableError(
            typeof data.error === "string" ? data.error : "no-port"
          )
        );
        return;
      }
      for (const extra of event.ports.slice(1)) extra.close();
      resolve(port);
    });

    win.postMessage({ type: RPC_CONNECT_REQUEST, nonce }, "*");
  });
};

/** The transport over this document's port. */
export const connectMessagePortTransport = async (
  options: ConnectOptions = {}
): Promise<Transport> => {
  const win: HandshakeWindow = options.win ?? window;
  const port = await requestRpcPort({ ...options, win });
  const getPathForFile = win.abacusHost?.getPathForFile;
  return createTransport(port, {
    kind: "message-port",
    host: getPathForFile == null ? {} : { getPathForFile },
  });
};
