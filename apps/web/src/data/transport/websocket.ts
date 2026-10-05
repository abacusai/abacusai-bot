import { createFlowControlLinkInterceptor } from "@abacus-ai/contract/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
/**
 * The client over a WebSocket (spec 00 A.8, spec 09 D2).
 *
 * `createSocketLink` is one socket's oRPC link: its own peer and its own
 * flow-control interceptor, whose acknowledgements are written to that
 * socket and nowhere else (a new socket restarts flow ids at `f1`, so an
 * acknowledgement moved to it would credit the wrong stream).
 *
 * `createHostTransport` is the browser page's one transport: a generation per
 * socket, and calls made while no socket is open wait for the next one,
 * re-checked synchronously right before dispatch. What a call may wait for
 * depends on its procedure (`intent.ts`), never on whether it has a signal:
 * a read waits as long as its signal allows (or the page lives); a write is
 * also held until the sign-in gate authorized writes, under the
 * authorization it was made in, and fails `HOST_UNAVAILABLE` one deadline
 * after it was made, never dispatched afterwards. Nothing here retries a
 * call: sockets are replaced by the connection manager, streams are reopened
 * by their loops, and uncertain sends are reconciled by admission.
 */
import { createORPCClient } from "@orpc/client";
import type { ClientLink } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { browserFileCall } from "#platform/host-files";

import { createCloseSignal, type CloseReason } from "./close-signal";
import { policyOf, type CallPolicy } from "./intent";
import { hostUnavailable, type TransportState } from "./lifecycle";
import type { AppClient, Transport } from "./types";

type CallInterceptorOptions = Parameters<
  NonNullable<
    import("@orpc/client/websocket").RPCLinkOptions<
      Record<string, never>
    >["interceptors"]
  >[number]
>[0];

export interface WebSocketTransportOptions {
  /** For tests; the global `WebSocket` otherwise. */
  WebSocket?: new (url: string) => WebSocket;
  flowControl?: boolean;
  inspectCall?: (path: string, error?: unknown) => void;
}

type Context = Record<string, never>;
type Link = ClientLink<Context>;

/**
 * The last check before a write leaves (spec 09 D2): `undefined` sends it,
 * `"wait"` keeps it unsent for the transport to wait again, anything else
 * is thrown, unsent.
 */
type SendGuard = () => unknown;

/** Context key and request header that tie a request frame to its guard. */
const GUARD = "abacusSendGuard";
const GUARD_HEADER = "x-abacus-send";
/** A request frame (not an event, abort or acknowledgement). */
const REQUEST_FRAME = /^\{"i":"[0-9a-z]+","p":/;
const GUARD_ID = /"x-abacus-send":"(\d+)"/;

/** Thrown in place of a socket write: nothing was sent. */
class NotSent extends Error {
  constructor(readonly reason: unknown) {
    super("not sent");
  }
}

/**
 * Runs a guarded request frame's guard right before `websocket.send`, after
 * oRPC encoded it, and drops the guard's header from a text frame. Frames
 * that are not requests (events, aborts) and flow acknowledgements, which
 * do not go through here, pass unchecked.
 */
const guardedSend = (
  websocket: WebSocket,
  guards: ReadonlyMap<string, SendGuard>,
  data: Parameters<WebSocket["send"]>[0]
): void => {
  if (guards.size > 0) {
    const text =
      typeof data === "string"
        ? data
        : ArrayBuffer.isView(data) || data instanceof ArrayBuffer
          ? new TextDecoder().decode(
              (ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data)
              ).subarray(0, 4096)
            )
          : "";
    const id = REQUEST_FRAME.test(text) ? GUARD_ID.exec(text)?.[1] : undefined;
    const guard = id == null ? undefined : guards.get(id);
    if (guard != null) {
      const refusal = guard();
      if (refusal !== undefined) throw new NotSent(refusal);
      if (typeof data === "string") {
        const frame = JSON.parse(data) as {
          p: { h?: Record<string, unknown> };
        };
        delete frame.p.h?.[GUARD_HEADER];
        if (frame.p.h != null && Object.keys(frame.p.h).length === 0)
          delete frame.p.h;
        data = JSON.stringify(frame);
      }
    }
  }
  websocket.send(data);
};

/** One socket's link; acknowledgements go to this socket only. */
const createSocketLink = (
  websocket: WebSocket,
  options: Omit<WebSocketTransportOptions, "WebSocket"> = {},
  guards: ReadonlyMap<string, SendGuard> = new Map()
): Link => {
  const sender = {
    get readyState() {
      return websocket.readyState;
    },
    addEventListener: websocket.addEventListener.bind(websocket),
    removeEventListener: websocket.removeEventListener.bind(websocket),
    send: (data: Parameters<WebSocket["send"]>[0]) =>
      guardedSend(websocket, guards, data),
  } as unknown as WebSocket;
  return new RPCLink({
    websocket: sender,
    clientInterceptors: [
      // Tags a guarded call's request frame (see `guardedSend`).
      ({ next, request, context, ...rest }) => {
        const id = (context as Record<string, unknown>)[GUARD];
        return next({
          ...rest,
          context,
          request:
            typeof id === "string"
              ? {
                  ...request,
                  headers: { ...request.headers, [GUARD_HEADER]: id },
                }
              : request,
        });
      },
      ...(options.flowControl === false
        ? []
        : [
            createFlowControlLinkInterceptor((ack) =>
              websocket.send(JSON.stringify(ack))
            ),
          ]),
    ],
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    interceptors: [
      async ({ path, input, next, signal }: CallInterceptorOptions) =>
        browserFileCall(path, input, next, signal),
      ...(options.inspectCall
        ? [
            async ({ path, next }: CallInterceptorOptions) => {
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
        : []),
    ],
  });
};

/**
 * One socket, closed for good when it closes (development smoke and tests).
 * Takes a URL, or a socket the caller has already opened.
 */
export const createWebSocketTransport = (
  url: string | WebSocket,
  options: WebSocketTransportOptions = {}
): Transport => {
  const Socket = options.WebSocket ?? WebSocket;
  const websocket = typeof url === "string" ? new Socket(url) : url;
  const signal = createCloseSignal();
  websocket.addEventListener("close", () => signal.fire("port-closed"));
  const client: AppClient = createORPCClient(
    createSocketLink(websocket, options)
  );
  return {
    kind: "websocket",
    client,
    orpc: createTanstackQueryUtils(client),
    host: {},
    get state() {
      return signal.state;
    },
    generation: 1,
    onChange: signal.onChange,
    writeTicket: () => 0,
    confirmWrites: () => {},
    suspendWrites: () => {},
    revokeWrites: () => {},
    onClose: signal.onClose,
    close: () => {
      if (signal.state === "closed") return;
      signal.fire("explicit");
      websocket.close();
    },
  };
};

/** A user's write waits this long for a socket before `HOST_UNAVAILABLE`. */
export const WRITE_DEADLINE_MS = 15_000;

/** How a generation ended: its socket's close code, or `UNRESPONSIVE`. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** `drop()`: the socket stopped answering; its own close may never come. */
export const UNRESPONSIVE = 4000;

export interface HostTransport extends Transport {
  /**
   * Starts the next generation over an open socket. When that socket closes
   * (or `drop()` ends it) the transport is `"reconnecting"` until the next
   * `attach()`. Resolves when this generation ends, with how.
   */
  attach(socket: WebSocket): Promise<CloseInfo>;
  /**
   * Ends the current generation now: its calls and streams fail as a
   * dropped socket's do. For a socket that stopped answering (a half-open
   * link keeps `readyState` at 1, and its close may come minutes later).
   */
  drop(reason: string): void;
  /** The close code that ended `generation` (the last 16 are kept). */
  closeCode(generation: number): number | undefined;
  /** When the open socket last delivered a frame; `0` without one. */
  heardAt(): number;
  /** Closed for good (identity, tier or contract): waiting calls fail. */
  fail(): void;
}

export interface HostTransportOptions extends Omit<
  WebSocketTransportOptions,
  "WebSocket"
> {
  deadlineMs?: number;
  /** Writes pass at once (tests); the browser holds them until confirmed. */
  writesConfirmed?: boolean;
  /**
   * Each replacement socket suspends writes until `confirmWrites()` (the
   * browser re-runs its sign-in gate first). On by default.
   */
  reauthorize?: boolean;
}

interface Generation {
  readonly socket: WebSocket;
  readonly link: Link;
  readonly number: number;
  ended: boolean;
  /** When the socket last delivered a frame (liveness). */
  heardAt: number;
  finish(info: CloseInfo): void;
}

/** One call, from the moment it was made. */
interface Call {
  readonly policy: CallPolicy;
  /** The write authorization it was made under. */
  readonly revision: number;
  /** One absolute deadline for the whole call (writes only). */
  readonly deadlineAt: number;
  readonly signal: AbortSignal | undefined;
}

interface Waiter {
  readonly call: Call;
  wake(): void;
}

const aborted = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The call was aborted", "AbortError");

/** oRPC's own error for a send on a socket that is no longer open. */
const NOT_OPEN = /WebSocket is not open/;

export const createHostTransport = (
  options: HostTransportOptions = {}
): HostTransport => {
  const deadlineMs = options.deadlineMs ?? WRITE_DEADLINE_MS;
  const reauthorize = options.reauthorize ?? true;
  const closeSignal = createCloseSignal();
  let state: TransportState = "connecting";
  let current: Generation | null = null;
  let count = 0;
  let authorized = options.writesConfirmed ?? false;
  // +1 whenever writes are revoked: a write made before never goes out.
  let revision = 0;
  const closes = new Map<number, number>();
  const waiters = new Set<Waiter>();
  const changes = new Set<{ listener: () => void }>();
  const guards = new Map<string, SendGuard>();
  let guardCount = 0;
  // +1 whenever writes are suspended or revoked: a confirmation decided
  // before (an old socket's gate check) is ignored.
  let suspensions = 0;

  const notify = (): void => {
    for (const registration of Array.from(changes)) {
      try {
        registration.listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  /**
   * Checked synchronously right before dispatch, and whenever something
   * changed: the generation to send on now, an error that ends the call
   * unsent, or `null` to keep waiting. `readyState` too: browsers run the
   * link's close listener (which fails its streams) before ours, and a
   * closing socket cannot send.
   */
  const verdict = (
    call: Call
  ): { go: Generation } | { fail: unknown } | null => {
    if (call.signal?.aborted) return { fail: aborted(call.signal) };
    if (state === "closed")
      return { fail: hostUnavailable("The host connection closed") };
    if (call.policy.authorize && call.revision !== revision)
      return {
        fail: hostUnavailable("Signed-in state changed; nothing was sent"),
      };
    if (Date.now() >= call.deadlineAt)
      return {
        fail: hostUnavailable(
          "The host is not connected yet; nothing was sent. Try again."
        ),
      };
    return state === "open" &&
      current != null &&
      current.socket.readyState === 1 &&
      (!call.policy.authorize || authorized)
      ? { go: current }
      : null;
  };

  const flush = (): void => {
    for (const waiter of Array.from(waiters))
      if (verdict(waiter.call) != null) waiter.wake();
  };

  /** Until something may have changed this call's verdict. */
  const wait = (call: Call): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = Number.isFinite(call.deadlineAt)
        ? setTimeout(wake, Math.max(0, call.deadlineAt - Date.now()))
        : undefined;
      const waiter: Waiter = { call, wake };
      function wake(): void {
        waiters.delete(waiter);
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", wake);
        resolve();
      }
      waiters.add(waiter);
      call.signal?.addEventListener("abort", wake, { once: true });
    });

  const link: Link = {
    async call(path, input, callOptions) {
      const policy = policyOf(path);
      const call: Call = {
        policy,
        revision,
        deadlineAt: policy.deadline ? Date.now() + deadlineMs : Infinity,
        signal: callOptions.signal,
      };
      // A write is checked again right before its frame leaves: oRPC
      // encodes it asynchronously after the check below.
      const guarded = policy.authorize || policy.deadline;
      const id = guarded ? String((guardCount += 1)) : undefined;
      try {
        for (;;) {
          const next = verdict(call);
          if (next == null) {
            await wait(call);
            continue;
          }
          if ("fail" in next) throw next.fail;
          const target = next.go;
          if (id != null)
            guards.set(id, () => {
              const now = verdict(call);
              if (now == null || ("go" in now && now.go !== target))
                return "wait";
              return "fail" in now ? now.fail : undefined;
            });
          try {
            return await target.link.call(
              path,
              input,
              id == null
                ? callOptions
                : {
                    ...callOptions,
                    context: { ...callOptions.context, [GUARD]: id } as never,
                  }
            );
          } catch (error) {
            // Nothing went out: refused at the send, or the socket closed
            // between the check above and the send.
            if (error instanceof NotSent) {
              if (error.reason === "wait") continue;
              throw error.reason;
            }
            if (error instanceof Error && NOT_OPEN.test(error.message))
              throw hostUnavailable("The host connection dropped; not sent");
            throw error;
          }
        }
      } finally {
        if (id != null) guards.delete(id);
      }
    },
  };
  const client: AppClient = createORPCClient(link);

  const setState = (next: TransportState): void => {
    if (state === "closed") return;
    state = next;
    flush();
    notify();
  };

  const end = (generation: Generation, info: CloseInfo): void => {
    if (generation.ended) return;
    generation.ended = true;
    closes.set(generation.number, info.code);
    closes.delete(generation.number - 16);
    if (current === generation) {
      current = null;
      setState("reconnecting");
    }
    generation.finish(info);
  };

  const terminate = (reason: CloseReason): void => {
    if (state === "closed") return;
    const generation = current;
    current = null;
    state = "closed";
    closeSignal.fire(reason);
    flush();
    notify();
    if (generation != null) {
      end(generation, { code: 1000, reason });
      generation.socket.close();
    }
  };

  return {
    kind: "websocket",
    client,
    orpc: createTanstackQueryUtils(client),
    host: {},
    get state() {
      return state;
    },
    get generation() {
      return count;
    },
    closeCode: (generation) => closes.get(generation),
    heardAt: () => current?.heardAt ?? 0,
    onChange(listener) {
      const registration = { listener };
      changes.add(registration);
      return () => {
        changes.delete(registration);
      };
    },
    writeTicket: () => suspensions,
    confirmWrites(ticket) {
      if (ticket != null && ticket !== suspensions) return;
      authorized = true;
      flush();
    },
    suspendWrites() {
      authorized = false;
      suspensions += 1;
    },
    revokeWrites() {
      authorized = false;
      revision += 1;
      suspensions += 1;
      flush();
    },
    attach(socket) {
      if (state === "closed") {
        socket.close();
        return Promise.resolve({ code: 1000, reason: "closed" });
      }
      count += 1;
      if (count > 1 && reauthorize) {
        authorized = false;
        suspensions += 1;
      }
      let finish!: (info: CloseInfo) => void;
      const ended = new Promise<CloseInfo>((resolve) => {
        finish = resolve;
      });
      // Ours first, before the link's: a stream that fails because this
      // socket closed already sees `reconnecting` (spec 09 D3).
      let generation: Generation | null = null;
      socket.addEventListener("close", (event) => {
        if (generation == null) return;
        const close = event as Partial<CloseEvent>;
        end(generation, {
          code: close.code ?? 1006,
          reason: close.reason ?? "",
        });
      });
      generation = {
        socket,
        link: createSocketLink(socket, options, guards),
        number: count,
        ended: false,
        heardAt: Date.now(),
        finish,
      };
      const heard = generation;
      socket.addEventListener("message", () => {
        heard.heardAt = Date.now();
      });
      const previous = current;
      current = generation;
      previous?.socket.close();
      setState("open");
      return ended;
    },
    drop(reason) {
      const generation = current;
      if (generation == null) return;
      end(generation, { code: UNRESPONSIVE, reason });
      try {
        generation.socket.close(UNRESPONSIVE, reason);
      } catch {
        // Already closing.
      }
      // The link learns of a close only from the socket; a half-open one
      // may not fire it for minutes, so its calls and streams fail now.
      generation.socket.dispatchEvent(new Event("close"));
    },
    fail: () => terminate("port-closed"),
    onClose: closeSignal.onClose,
    close: () => terminate("explicit"),
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
