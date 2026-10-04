import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { createFlowControlLinkInterceptor } from "@abacus-ai/contract/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";

import {
  createCloseSignal,
  type CloseReason,
  type CloseSignal,
} from "./close-signal";
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

type Listener = (event: Event) => void;

/**
 * The port as the link sees it, with `close` delivered locally too. The HTML
 * spec fires `close` only at the *other* end of a disentangled channel, so
 * closing our own end would otherwise leave oRPC's peer open: pending calls
 * and iterator reads would never settle and would keep their queues. Close
 * listeners run exactly once, whichever end closed.
 */
const trackClose = (
  port: TransportPort,
  signal: CloseSignal
): { port: TransportPort; close(): void } => {
  const listeners: Listener[] = [];
  let closed = false;
  const notify = (event: Event, reason: CloseReason): void => {
    if (closed) return;
    closed = true;
    // The transport's state flips before oRPC's peer (or anyone) hears it.
    signal.fire(reason);
    for (const listener of listeners) listener(event);
  };
  port.addEventListener("close", (event) => notify(event, "port-closed"));

  const tracked: TransportPort = {
    addEventListener: ((
      type: string,
      listener: Listener,
      options?: AddEventListenerOptions | boolean
    ) => {
      if (type === "close") listeners.push(listener);
      else port.addEventListener(type as "message", listener, options);
    }) as TransportPort["addEventListener"],
    postMessage: ((message: unknown, transfer?: Transferable[]) => {
      if (transfer == null) port.postMessage(message);
      else port.postMessage(message, transfer);
    }) as TransportPort["postMessage"],
    start: () => port.start(),
    close: () => {
      if (closed) return;
      port.close();
      notify(new Event("close"), "explicit");
    },
  };
  return { port: tracked, close: tracked.close };
};

export interface CreateTransportOptions {
  kind?: TransportKind;
  host?: TransportHost;
  /**
   * Acknowledge consumed iterator events so main sends no further ahead than
   * the flow window (shared/contract/flow-control.ts). On by default; the
   * other end must understand the acknowledgements.
   */
  flowControl?: boolean;
}

/**
 * A transport over an already-connected port: the oRPC link (with the
 * Uint8Array serializer main also registers), the typed client, and the
 * TanStack Query utilities over it.
 */
export const createTransport = (
  rawPort: TransportPort,
  options: CreateTransportOptions = {}
): Transport => {
  const signal = createCloseSignal();
  const { port, close } = trackClose(rawPort, signal);
  const link = new RPCLink({
    port,
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    clientInterceptors:
      options.flowControl === false
        ? []
        : [createFlowControlLinkInterceptor((ack) => port.postMessage(ack))],
  });
  port.start();
  const client: AppClient = createORPCClient(link);

  return {
    kind: options.kind ?? "message-port",
    client,
    orpc: createTanstackQueryUtils(client),
    host: options.host ?? {},
    get state() {
      return signal.state;
    },
    onClose: signal.onClose,
    close,
  };
};
