/**
 * The renderer's notice streams (spec 00 A.12). `followNotices` consumes
 * one as a raw iterator with a signal: a stream that ends or fails is
 * reopened after a short delay while the transport is open, at once on the
 * next connection after a socket was replaced, and only after the first one
 * opens on a page still connecting (spec 09 D3); keyed streams call it
 * directly. Every keyless `*.events` stream is opened once per transport
 * and fanned out to whoever follows it, however many areas do; it closes
 * with its last follower. (One module, also for the notch document, so the
 * Electron renderer gains no chunk.)
 *
 * Each area follows the streams it needs with `followNotice` from the
 * globals it already mounts: invalidations, the state a notice carries,
 * side effects that need each event (a notification per new ask, a preview
 * to open). `noticeSnapshot` reads a snapshot stream's state.
 *
 * A stream whose first yield is a snapshot keeps it current (`fold`), so a
 * follower that joins an open stream first receives that snapshot, just as
 * a stream of its own would have started. Followers are isolated: each
 * registration is its own record (the same callback twice is two), a throw
 * is reported and skipped so it neither starves the others nor reaches
 * `followNotices` (where it would read as a stream failure), and
 * cancellation is installed before any follower code runs.
 */
import type { AttentionEvent } from "@abacus-ai/contract/contract/ai";
import type { BrowserEvent } from "@abacus-ai/contract/contract/browser";
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

// ── keyless streams ──────────────────────────────────────────────────────

type Client = Transport["client"];
type Open<T> = (
  client: Client,
  signal: AbortSignal
) => Promise<AsyncIterable<T>>;
type Fold<T> = (snapshot: T | undefined, event: T) => T | undefined;

const source = <T>(open: Open<T>, fold?: Fold<T>) => ({ open, fold });

const foldAttention: Fold<AttentionEvent> = (snapshot, event) => {
  if (event.type === "snapshot") return event;
  if (snapshot?.type !== "snapshot") return snapshot;
  const threadId =
    event.type === "upsert" ? event.item.threadId : event.threadId;
  const items = snapshot.items.filter((item) => item.threadId !== threadId);
  if (event.type === "upsert") items.push(event.item);
  return { ...snapshot, revision: event.revision, items };
};

const foldConnectors: Fold<ConnectorsEvent> = (snapshot, event) => {
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
};

const foldBrowser: Fold<BrowserEvent> = (snapshot, event) => {
  if (event.type === "snapshot") return event;
  if (snapshot?.type !== "snapshot") return snapshot;
  if (event.type === "permission-request")
    return {
      ...snapshot,
      permissionRequests: [
        ...snapshot.permissionRequests.filter(
          (request) => request.requestId !== event.request.requestId
        ),
        event.request,
      ],
    };
  if (event.type === "permission-cleared")
    return {
      ...snapshot,
      permissionRequests: snapshot.permissionRequests.filter(
        (request) => request.requestId !== event.requestId
      ),
    };
  return snapshot;
};

/** Every keyless stream; the parameter is `client` for the stream census. */
const SOURCES = {
  attention: source(
    (client, signal) => client.ai.attention({}, { signal }),
    foldAttention
  ),
  bots: source((client, signal) => client.bots.events({}, { signal })),
  browser: source(
    (client, signal) => client.browser.events({}, { signal }),
    foldBrowser
  ),
  connectors: source(
    (client, signal) => client.connectors.events({}, { signal }),
    foldConnectors
  ),
  // No fold: one follower (`LibraryGlobals`) for the document's life.
  devices: source((client, signal) => client.devices.events({}, { signal })),
  files: source((client, signal) => client.files.events({}, { signal })),
  memory: source((client, signal) => client.memory.events({}, { signal })),
  messaging: source((client, signal) =>
    client.messaging.events({}, { signal })
  ),
  routines: source((client, signal) => client.routines.events({}, { signal })),
  settings: source((client, signal) => client.settings.events({}, { signal })),
  system: source((client, signal) => client.system.events({}, { signal })),
  window: source((client, signal) => client.window.events({}, { signal })),
};

export type NoticeStream = keyof typeof SOURCES;
export type NoticeOf<S extends NoticeStream> = (typeof SOURCES)[S] extends {
  open: Open<infer T>;
}
  ? T
  : never;
/** The streams whose first yield is a snapshot. */
type SnapshotStream = "attention" | "browser" | "connectors";

interface Follower {
  receive(event: unknown): void;
  reopened?(): void;
  ended?(): void;
}
interface Hub {
  followers: Set<Follower>;
  snapshot?: unknown;
  abort: AbortController;
}

const report = (run: () => void): void => {
  try {
    run();
  } catch (error) {
    console.error("[renderer] notice follower failed", error);
  }
};

const hubs = new WeakMap<Transport, Map<NoticeStream, Hub>>();

const hubsOf = (transport: Transport): Map<NoticeStream, Hub> => {
  let map = hubs.get(transport);
  if (map == null) {
    map = new Map();
    hubs.set(transport, map);
  }
  return map;
};

const start = (transport: Transport, stream: NoticeStream): Hub => {
  const { open, fold } = SOURCES[stream] as {
    open: Open<unknown>;
    fold?: Fold<unknown>;
  };
  const hub: Hub = { followers: new Set(), abort: new AbortController() };
  const map = hubsOf(transport);
  map.set(stream, hub);
  // A copy each time: one that joins during the fan-out already got the
  // folded snapshot; one that leaves is skipped.
  const each = (run: (follower: Follower) => void): void => {
    for (const follower of Array.from(hub.followers))
      if (hub.followers.has(follower)) report(() => run(follower));
  };
  let opened = false;
  void followNotices(
    transport,
    async ({ signal }) => {
      const events = await open(transport.client, signal);
      if (opened) each((follower) => follower.reopened?.());
      opened = true;
      return events;
    },
    (event) => {
      if (fold != null) hub.snapshot = fold(hub.snapshot, event);
      each((follower) => follower.receive(event));
    },
    hub.abort.signal
  ).finally(() => {
    if (map.get(stream) === hub) map.delete(stream);
    // Stopped for good (a final code, the transport closed): say so, unless
    // the last follower left.
    if (!hub.abort.signal.aborted) each((follower) => follower.ended?.());
  });
  return hub;
};

/**
 * Follow `stream` on `transport` until `signal` aborts. `reopened` runs
 * each time the stream opened again after its first open (what a notice
 * sent while it was down would have done is now due); `ended` once if the
 * stream stopped for good while followed.
 */
export const followNotice = <S extends NoticeStream>(
  stream: S,
  transport: Transport,
  onEvent: (event: NoticeOf<S>) => void,
  signal: AbortSignal,
  hooks: { reopened?(): void; ended?(): void } = {}
): void => {
  if (signal.aborted) return;
  const map = hubsOf(transport);
  const joined = map.get(stream);
  const hub = joined ?? start(transport, stream);
  const follower: Follower = {
    receive: onEvent as (event: unknown) => void,
    ...hooks,
  };
  hub.followers.add(follower);
  const leave = (): void => {
    if (!hub.followers.delete(follower)) return;
    if (hub.followers.size > 0) return;
    if (map.get(stream) === hub) map.delete(stream);
    hub.abort.abort();
  };
  signal.addEventListener("abort", leave, { once: true });
  if (joined?.snapshot !== undefined) {
    const snapshot = joined.snapshot;
    report(() => follower.receive(snapshot));
  }
  // The snapshot may have aborted the signal itself.
  if (signal.aborted) leave();
};

interface SnapshotSource<T> {
  /** For `useSyncExternalStore`: follows the stream while subscribed. */
  subscribe(changed: () => void): () => void;
  /** The latest state, or `undefined` until the first arrives. */
  get(): T | undefined;
}
const sources = new WeakMap<Transport, Map<SnapshotStream, unknown>>();

/**
 * A snapshot stream's state (its first yield, kept current), as an
 * external store: `useSyncExternalStore(source.subscribe, source.get)`.
 * Each subscriber follows the stream itself, so the hub stays open while
 * any is mounted, whoever else follows it. The last state outlives a
 * stream that stopped for good, and subscribers hear that it stopped. One
 * object per stream and transport, so the subscription stays put. (No
 * React here: the chat runtime and the notch document load this module.)
 */
export const noticeSnapshot = <S extends SnapshotStream>(
  stream: S,
  transport: Transport
): SnapshotSource<Extract<NoticeOf<S>, { type: "snapshot" }>> => {
  type Snapshot = Extract<NoticeOf<S>, { type: "snapshot" }>;
  let map = sources.get(transport);
  if (map == null) {
    map = new Map();
    sources.set(transport, map);
  }
  let source = map.get(stream) as SnapshotSource<Snapshot> | undefined;
  if (source == null) {
    let last: Snapshot | undefined;
    source = {
      subscribe: (changed) => {
        const abort = new AbortController();
        followNotice(
          stream,
          transport,
          () => {
            last = hubs.get(transport)?.get(stream)?.snapshot as
              | Snapshot
              | undefined;
            changed();
          },
          abort.signal,
          { ended: changed }
        );
        return () => abort.abort();
      },
      get: () => last,
    };
    map.set(stream, source);
  }
  return source;
};
