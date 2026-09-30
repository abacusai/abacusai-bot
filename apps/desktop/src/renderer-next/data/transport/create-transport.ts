import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import type {
  AppClient,
  Transport,
  TransportHost,
  TransportKind,
} from "./types";

/** The port surface the link needs; a DOM `MessagePort` has it. */
export type TransportPort = Pick<
  MessagePort,
  "addEventListener" | "postMessage" | "start" | "close"
>;

/**
 * A transport over an already-connected port: the oRPC link (with the
 * Uint8Array serializer main also registers), the typed client, and the
 * TanStack Query utilities over it.
 */
export const createTransport = (
  port: TransportPort,
  options: { kind?: TransportKind; host?: TransportHost } = {}
): Transport => {
  const link = new RPCLink({
    port,
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  });
  port.start();
  const client: AppClient = createORPCClient(link);

  return {
    kind: options.kind ?? "message-port",
    client,
    orpc: createTanstackQueryUtils(client),
    host: options.host ?? {},
    close: () => port.close(),
  };
};
