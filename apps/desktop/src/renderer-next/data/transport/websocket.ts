/**
 * The same client over a WebSocket (spec 00 A.8): development smoke only
 * today, a web mode later. Event iterators retry and resume with
 * `lastEventId`.
 */
import { createORPCClient } from "@orpc/client";
import { ClientRetryPlugin } from "@orpc/client/plugins";
import { RPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import type { AppClient, Transport } from "./types";

export const createWebSocketTransport = (url: string): Transport => {
  const websocket = new WebSocket(url);
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
    close: () => websocket.close(),
  };
};
