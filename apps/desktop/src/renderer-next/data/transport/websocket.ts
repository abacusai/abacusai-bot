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

import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import { createCloseSignal } from "./close-signal";
import type { AppClient, Transport } from "./types";

export interface WebSocketTransportOptions {
  /** For tests; the global `WebSocket` otherwise. */
  WebSocket?: new (url: string) => WebSocket;
}

export const createWebSocketTransport = (
  url: string,
  options: WebSocketTransportOptions = {}
): Transport => {
  const Socket = options.WebSocket ?? WebSocket;
  const websocket = new Socket(url);
  const signal = createCloseSignal();
  websocket.addEventListener("close", () => signal.fire("port-closed"));

  const link = new RPCLink({
    websocket,
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    plugins: [new ClientRetryPlugin()],
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
