/**
 * What every procedures/<domain>.ts shares: the implementer bound to the
 * contract and the RPC context, the window guards, and the one helper every
 * event iterator is built from.
 */
import { implement } from "@orpc/server";

import { contract } from "#shared/contract";
import type { IpcEvent } from "#shared/contracts";

import type { RpcContext } from "../context";
import { DELIVERY, type StreamPath } from "../delivery";
import { forbidden } from "../errors";
import type { BusChannel, BusChannels } from "../event-bus";
import { SubscriberQueue } from "../subscriber-queue";

export const impl = implement(contract).$context<RpcContext>();

/** The caller's webContents id; `FORBIDDEN` over a transport with no window. */
export const requireWindow = (context: RpcContext): number => {
  if (context.webContentsId == null)
    throw forbidden("This procedure needs a window; this transport has none");
  return context.webContentsId;
};

/** As the legacy browser runtime channels: the live main renderer only. */
export const requireMainRenderer = (context: RpcContext): number => {
  const id = requireWindow(context);
  if (
    context.windowKind !== "main" ||
    context.deps.windows.mainRendererId() !== id
  )
    throw forbidden("The browser runtime is restricted to the main renderer");
  return id;
};

export interface StreamOptions<T> {
  path: StreamPath;
  context: RpcContext;
  signal: AbortSignal | undefined;
  /**
   * Register listeners and return their removal. Called before `initial`, so
   * nothing that happens while the snapshot is read is missed.
   */
  attach: (push: (event: T) => void, end: () => void) => () => void;
  /** The first yields: a snapshot of the state the events then update. */
  initial?: () => T[] | Promise<T[]>;
  coalesceKey?: (event: T) => string | null;
  sizeOf?: (event: T) => number;
  maxBytes?: number;
}

/**
 * An event iterator over the bus, queued per the stream's declared delivery
 * class. Listeners are removed however the stream ends: drained, overflowed,
 * aborted by a closed port, or returned early by the client.
 */
export async function* stream<T>(
  options: StreamOptions<T>
): AsyncGenerator<T, void, unknown> {
  const queue = new SubscriberQueue<T>({
    stream: options.path,
    delivery: DELIVERY[options.path],
    coalesceKey: options.coalesceKey,
    sizeOf: options.sizeOf,
    maxBytes: options.maxBytes,
  });
  let detached = false;
  let detachListeners: (() => void) | null = null;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    detachListeners?.();
  };
  detachListeners = options.attach(
    (event) => {
      queue.push(event);
      // Overflowed while the consumer is parked (flow control holds it back):
      // the queue has dropped its backlog, so stop listening now rather than
      // when the consumer next reads.
      if (queue.failed) detach();
    },
    () => queue.end()
  );
  if (detached) detachListeners();
  try {
    for (const event of (await options.initial?.()) ?? []) yield event;
    for (;;) {
      const result = await queue.next(options.signal);
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    detach();
  }
}

/** Attach to `IpcEvent`s matching `filter`, mapped (null skips). */
export const onIpcEvents =
  <T>(
    context: RpcContext,
    filter: (event: IpcEvent) => boolean,
    map: (event: IpcEvent) => T | null
  ) =>
  (push: (event: T) => void): (() => void) =>
    context.deps.bus.listen(filter, (event) => {
      const mapped = map(event);
      if (mapped != null) push(mapped);
    });

/** Attach to one of the bus's own channels. */
export const onChannel =
  <C extends BusChannel, T>(
    context: RpcContext,
    channel: C,
    map: (payload: BusChannels[C]) => T | null
  ) =>
  (push: (event: T) => void): (() => void) =>
    context.deps.bus.listenChannel(channel, (payload) => {
      const mapped = map(payload);
      if (mapped != null) push(mapped);
    });

/** `IpcEvent` narrowed by its `type`. */
export type IpcEventOf<K extends IpcEvent["type"]> = Extract<
  IpcEvent,
  { type: K }
>;

export const isType =
  <K extends IpcEvent["type"]>(...types: K[]) =>
  (event: IpcEvent): event is IpcEventOf<K> =>
    (types as string[]).includes(event.type);
