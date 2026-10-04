import { createFlowControlLinkInterceptor } from "@abacus-ai/contract/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
/**
 * The same client over a WebSocket (spec 00 A.8): development smoke only
 * today, a web mode later. Event iterators retry and resume with
 * `lastEventId`.
 *
 * Lifecycle (spec 01 §15.5): the socket's `close` event closes the transport
 * with `"port-closed"`; `close()` reports `"explicit"` first.
 */
import { createORPCClient } from "@orpc/client";
import { ClientRetryPlugin } from "@orpc/client/plugins";
import { RPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { createCloseSignal } from "./close-signal";
import type { AppClient, Transport } from "./types";

export interface WebSocketTransportOptions {
  /** For tests; the global `WebSocket` otherwise. */
  WebSocket?: new (url: string, protocols?: string[]) => WebSocket;
  protocols?: string[];
  flowControl?: boolean;
  inspectCall?: (path: string, error?: unknown) => void;
}

export const createWebSocketTransport = (
  url: string,
  options: WebSocketTransportOptions = {}
): Transport => {
  const Socket = options.WebSocket ?? WebSocket;
  const websocket = new Socket(url, options.protocols);
  const signal = createCloseSignal();
  websocket.addEventListener("close", () => signal.fire("port-closed"));

  const link = new RPCLink({
    websocket,
    clientInterceptors:
      options.flowControl === false
        ? []
        : [
            createFlowControlLinkInterceptor((ack) =>
              websocket.send(JSON.stringify(ack))
            ),
          ],
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    plugins: [new ClientRetryPlugin()],
    interceptors: options.inspectCall
      ? [
          async ({ path, next }) => {
            const procedure = path.join(".");
            options.inspectCall?.(procedure);
            try {
              return await next();
            } catch (error) {
              options.inspectCall?.(procedure, error);
              throw error;
            }
          },
        ]
      : [],
  });
  const client: AppClient = createORPCClient(link);

  return {
    kind: "websocket",
    client,
    orpc: createTanstackQueryUtils(client),
    host: {},
    get state() {
      return signal.state;
    },
    onClose: signal.onClose,
    close: () => {
      if (signal.state === "closed") return;
      signal.fire("explicit");
      websocket.close();
    },
  };
};

export const awaitWebSocketOpen = (
  socket: WebSocket,
  timeoutMs = 10_000
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", fail);
      socket.removeEventListener("close", fail);
    };
    const open = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      socket.close();
      reject(new Error("WebSocket handshake failed"));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("close", fail, { once: true });
  });
export const connectWebSocketTransport = async (
  url: string,
  protocols: string[]
): Promise<Transport> => {
  const socket = new WebSocket(url, protocols);
  await awaitWebSocketOpen(socket);
  return createWebSocketTransport(url, {
    WebSocket: class {
      constructor() {
        return socket;
      }
    } as unknown as typeof WebSocket,
    protocols,
  });
};
