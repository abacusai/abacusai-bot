/**
 * The test double: a real transport over an in-process MessageChannel, with
 * the real oRPC handler and link on either end. Give it a router (main's, over
 * fakes, or one built with `implement(contract)` for the case at hand) and the
 * context each call sees.
 */
import type { Context, Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";

import {
  FLOW_CONTEXT_KEY,
  FlowRegistry,
  flowControlHandlerInterceptor,
  withFlowAcks,
} from "#shared/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import { createTransport } from "./create-transport";
import type { Transport, TransportHost } from "./types";

export interface MemoryTransport extends Transport {
  /** The server's end, to close it from main's side in a test. */
  readonly serverPort: MessagePort;
}

export const createMemoryTransport = <TContext extends Context>(
  router: Router<any, TContext>,
  context: TContext,
  options: { host?: TransportHost } = {}
): MemoryTransport => {
  const { port1: serverPort, port2: clientPort } = new MessageChannel();
  const handler = new RPCHandler<TContext>(router, {
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    interceptors: [flowControlHandlerInterceptor],
  });
  // As main's port: iterators are gated on the link's acknowledgements.
  const flows = new FlowRegistry();
  // Widened: the options type is conditional on the context and does not
  // resolve for a generic one.
  (handler as unknown as RPCHandler<Context>).upgrade(
    withFlowAcks(serverPort, flows),
    { context: { ...context, [FLOW_CONTEXT_KEY]: flows } }
  );
  serverPort.start();

  const transport = createTransport(clientPort, {
    kind: "memory",
    host: options.host ?? {},
  });
  // Not a spread: `state` is a getter and must stay live. Closing either end
  // closes the transport: the client's own `close()` reports "explicit";
  // `serverPort.close()` (main going away) reaches the client end as
  // "port-closed".
  return {
    kind: transport.kind,
    client: transport.client,
    orpc: transport.orpc,
    host: transport.host,
    serverPort,
    get state() {
      return transport.state;
    },
    onClose: (listener) => transport.onClose(listener),
    close: () => {
      transport.close();
      serverPort.close();
    },
  };
};
