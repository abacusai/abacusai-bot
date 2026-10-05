/**
 * The one place renderer opens a low-rate notice stream (spec 00 A.12):
 * `window.events`, `settings.events`, … Consumed as raw iterators with a
 * signal; a stream that ends or fails is reopened after a short delay while
 * the transport is open, at once on the next connection after a socket was
 * replaced, and only after the first one opens on a page still connecting
 * (spec 09 D3). (`experimental_liveOptions` would cache the last event as
 * query data; nothing here needs that yet.)
 */
import type { AttentionEvent } from "@abacus-ai/contract/contract/ai";
import type { ConnectorsEvent } from "@abacus-ai/contract/contract/connectors";

import type { Transport } from "#renderer/data/transport";
import type { TransportState } from "#renderer/data/transport/lifecycle";

/** What a consumer that follows the connection reads. */
export interface ConnectionSource {
  readonly state: TransportState;
  /** +1 per opened socket; a MessagePort stays at 1. */
  readonly generation?: number;
  /** Runs after every state or generation change. Returns an unsubscribe. */
  onChange?(listener: () => void): () => void;
  /** The close code that ended `generation`, once it has (web only). */
  closeCode?(generation: number): number | undefined;
}

/**
 * Resolves `true` once `source` is open, `false` when it closed for good or
 * `signal` aborted first.
 */
export const untilOpen = (
  source: ConnectionSource,
  signal?: AbortSignal
): Promise<boolean> => {
  if (signal?.aborted || source.state === "closed")
    return Promise.resolve(false);
  if (source.state === "open" || source.onChange == null)
    return Promise.resolve(source.state === "open");
  return new Promise((resolve) => {
    const finish = (open: boolean): void => {
      off();
      signal?.removeEventListener("abort", aborted);
      resolve(open);
    };
    const aborted = (): void => finish(false);
    const off = source.onChange!(() => {
      if (source.state === "open") finish(true);
      else if (source.state === "closed") finish(false);
    });
    signal?.addEventListener("abort", aborted, { once: true });
  });
};

const REOPEN_MS = 1_000;

/**
 * Codes a reopen cannot fix (a transport with no window, a procedure this
 * main does not serve): the loop stops instead of retrying every second for
 * the life of the document (Claude impl r1 #22).
 */
const FINAL_CODES: ReadonlySet<string> = new Set([
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "BAD_REQUEST",
  "METHOD_NOT_SUPPORTED",
]);

const isFinal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  FINAL_CODES.has(String((error as { code?: unknown }).code));

/**
 * Consume `open()`'s iterator until `signal` aborts, calling `onEvent` per
 * event. Resolves when aborted or when the transport closed for good.
 */
export const followNotices = async <T>(
  transport: ConnectionSource,
  open: (options: { signal: AbortSignal }) => Promise<AsyncIterable<T>>,
  onEvent: (event: T) => void,
  signal: AbortSignal
): Promise<void> => {
  while (await untilOpen(transport, signal)) {
    const generation = transport.generation;
    try {
      const events = await open({ signal });
      for await (const event of events) {
        if (signal.aborted) return;
        onEvent(event);
      }
    } catch (error) {
      // Reopened below unless it can never succeed.
      if (isFinal(error)) return;
    }
    if (signal.aborted) return;
    // The same connection failed or ended the stream: pause before the
    // reopen. A replaced one reopens as soon as the next socket is open.
    if (transport.state === "open" && transport.generation === generation)
      await new Promise((resolve) => setTimeout(resolve, REOPEN_MS));
  }
};

type Follow<T> = (
  transport: Transport,
  onEvent: (event: T) => void,
  signal: AbortSignal
) => void;

/**
 * One `open()` stream per transport, fanned out to every subscriber; it
 * closes when the last subscriber's signal aborts. Each stream starts with
 * a snapshot, which `fold` keeps current from the events that follow, so a
 * subscriber that joins an open stream first receives that snapshot, just
 * as a stream of its own would have started.
 *
 * Subscribers are isolated: each registration is its own record (the same
 * callback twice is two subscriptions), a throw is reported and skipped so
 * it neither starves the others nor reaches `followNotices` (where it would
 * read as a stream failure and reopen or stop the stream), and cancellation
 * is installed before any subscriber code runs.
 */
const shareNotices = <T>(
  open: (
    transport: Transport,
    signal: AbortSignal
  ) => Promise<AsyncIterable<T>>,
  fold: (snapshot: T | undefined, event: T) => T | undefined
): Follow<T> => {
  interface Subscription {
    receive: (event: T) => void;
  }
  interface Hub {
    subscriptions: Set<Subscription>;
    snapshot?: T;
    abort: AbortController;
  }
  const deliver = (subscription: Subscription, event: T): void => {
    try {
      subscription.receive(event);
    } catch (error) {
      console.error("[renderer] notice subscriber failed", error);
    }
  };
  const hubs = new WeakMap<Transport, Hub>();
  const start = (transport: Transport): Hub => {
    const hub: Hub = { subscriptions: new Set(), abort: new AbortController() };
    hubs.set(transport, hub);
    void followNotices(
      transport,
      ({ signal }) => open(transport, signal),
      (event) => {
        hub.snapshot = fold(hub.snapshot, event);
        // A copy: one that joins during the fan-out already got the folded
        // snapshot; one that leaves is skipped.
        for (const subscription of Array.from(hub.subscriptions))
          if (hub.subscriptions.has(subscription)) deliver(subscription, event);
      },
      hub.abort.signal
    ).finally(() => {
      if (hubs.get(transport) === hub) hubs.delete(transport);
    });
    return hub;
  };
  return (transport, onEvent, signal) => {
    if (signal.aborted) return;
    const joined = hubs.get(transport);
    const hub = joined ?? start(transport);
    const subscription: Subscription = { receive: onEvent };
    hub.subscriptions.add(subscription);
    const leave = (): void => {
      if (!hub.subscriptions.delete(subscription)) return;
      if (hub.subscriptions.size > 0) return;
      if (hubs.get(transport) === hub) hubs.delete(transport);
      hub.abort.abort();
    };
    signal.addEventListener("abort", leave, { once: true });
    if (joined?.snapshot !== undefined) deliver(subscription, joined.snapshot);
    // The snapshot may have aborted the signal itself.
    if (signal.aborted) leave();
  };
};

/** Keyless `ai.attention`: every thread's pending questions and approvals. */
export const followAttention: Follow<AttentionEvent> = shareNotices(
  (transport, signal) => transport.client.ai.attention({}, { signal }),
  (snapshot, event) => {
    if (event.type === "snapshot") return event;
    if (snapshot?.type !== "snapshot") return snapshot;
    const threadId =
      event.type === "upsert" ? event.item.threadId : event.threadId;
    const items = snapshot.items.filter((item) => item.threadId !== threadId);
    if (event.type === "upsert") items.push(event.item);
    return { ...snapshot, revision: event.revision, items };
  }
);

/** Keyless `connectors.events`: asks in every conversation, status changes. */
export const followConnectorEvents: Follow<ConnectorsEvent> = shareNotices(
  (transport, signal) => transport.client.connectors.events({}, { signal }),
  (snapshot, event) => {
    if (event.type === "snapshot") return event;
    if (snapshot?.type !== "snapshot") return snapshot;
    if (event.type === "request")
      return {
        ...snapshot,
        requests: [
          ...snapshot.requests.filter(
            (request) => request.requestId !== event.request.requestId
          ),
          event.request,
        ],
      };
    if (event.type === "cleared")
      return {
        ...snapshot,
        requests: snapshot.requests.filter(
          (request) => request.requestId !== event.requestId
        ),
      };
    return snapshot;
  }
);
