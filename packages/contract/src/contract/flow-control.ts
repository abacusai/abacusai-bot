/**
 * Credit-based flow control for event iterators over a MessagePort (spec 00
 * A.4.3, "Implementation notes (sub-slice A)").
 *
 * oRPC 1.15.4's server peer drains a returned iterator as fast as `send`
 * resolves (`resolveEventIterator` in `@orpc/standard-server-peer`), and
 * `postMessage` resolves at once; the client peer pushes every event into an
 * unbounded `AsyncIdQueue` whether or not anyone calls `next()`. Without this
 * module, a renderer that stops reading gets main's whole backlog copied into
 * its own heap, and main's per-subscriber limits never trip.
 *
 * With it, every call carries a flow id and a window in the `x-abacus-flow`
 * header. Main pulls at most `window` events from an iterator ahead of what
 * the renderer has consumed; the renderer's link acknowledges each event the
 * consumer actually receives from `next()`, on the same port, batched per
 * microtask. A stalled consumer therefore leaves the backlog in main's
 * subscriber queue, where the delivery class's limits apply (`RESYNC_REQUIRED`).
 *
 * Both halves live here, Electron-free, so the renderer's memory transport and
 * main's MessagePort transport share them. A port that does not speak the
 * protocol (the WebSocket smoke transport) sends no header and is ungated.
 */

export const FLOW_HEADER = "x-abacus-flow";
export const FLOW_ACK = "abacus:rpc-flow-ack";
/** Events main may send ahead of the consumer, per iterator. */
export const DEFAULT_FLOW_WINDOW = 64;

export interface FlowAck {
  type: typeof FLOW_ACK;
  acks: Array<[flow: string, consumed: number]>;
}

export const isFlowAck = (value: unknown): value is FlowAck =>
  typeof value === "object" &&
  value != null &&
  (value as { type?: unknown }).type === FLOW_ACK &&
  Array.isArray((value as { acks?: unknown }).acks);

export const formatFlowHeader = (flow: string, window: number): string =>
  `${flow};${window}`;

export const parseFlowHeader = (
  value: unknown
): { flow: string; window: number } | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const separator = raw.lastIndexOf(";");
  if (separator <= 0) return null;
  const window = Number(raw.slice(separator + 1));
  if (!Number.isInteger(window) || window < 1) return null;
  return { flow: raw.slice(0, separator), window };
};

const isAsyncIteratorObject = (
  value: unknown
): value is AsyncIterator<unknown, unknown, unknown> & AsyncIterable<unknown> =>
  typeof value === "object" &&
  value != null &&
  typeof (value as { next?: unknown }).next === "function" &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ] === "function";

/* ------------------------------------------------------------------ client */

interface LinkInterceptorOptions {
  request: { headers: Record<string, string | string[] | undefined> };
  next: (options?: any) => Promise<{ body: () => Promise<unknown> }>;
}

/** Wraps `inner` so each value the consumer receives calls `consumed`. */
const acknowledging = (
  inner: AsyncIterator<unknown, unknown, unknown>,
  consumed: () => void
): AsyncIterator<unknown, unknown, unknown> & AsyncIterable<unknown> => ({
  async next() {
    const result = await inner.next();
    if (result.done !== true) consumed();
    return result;
  },
  async return(value?: unknown) {
    return (await inner.return?.(value)) ?? { done: true, value };
  },
  async throw(error?: unknown) {
    if (inner.throw != null) return inner.throw(error);
    throw error;
  },
  [Symbol.asyncIterator]() {
    return this;
  },
});

/**
 * The renderer half: an `RPCLink` `clientInterceptors` entry. `post` sends an
 * acknowledgement on the same port the link uses.
 */
export const createFlowControlLinkInterceptor = (
  post: (ack: FlowAck) => void,
  window = DEFAULT_FLOW_WINDOW
) => {
  let counter = 0;
  const pending = new Map<string, number>();
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (pending.size === 0) return;
    const acks = Array.from(pending);
    pending.clear();
    try {
      post({ type: FLOW_ACK, acks });
    } catch {
      // The port is closed; its iterators are ending anyway.
    }
  };

  const consumed = (flow: string): void => {
    pending.set(flow, (pending.get(flow) ?? 0) + 1);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  return async <T extends LinkInterceptorOptions>(
    options: T
  ): Promise<Awaited<ReturnType<T["next"]>>> => {
    counter += 1;
    const flow = `f${counter}`;
    const { next, ...rest } = options;
    const response = await next({
      ...rest,
      request: {
        ...options.request,
        headers: {
          ...options.request.headers,
          [FLOW_HEADER]: formatFlowHeader(flow, window),
        },
      },
    });
    const body = response.body;
    return {
      ...response,
      body: async () => {
        const value = await body();
        return isAsyncIteratorObject(value)
          ? acknowledging(value, () => consumed(flow))
          : value;
      },
    } as Awaited<ReturnType<T["next"]>>;
  };
};

/* ------------------------------------------------------------------ server */

class Flow {
  #credits: number;
  #wake: (() => void) | null = null;
  #closed = false;

  constructor(window: number) {
    this.#credits = window;
  }

  get credits(): number {
    return this.#credits;
  }

  grant(count: number): void {
    this.#credits += count;
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#notify();
  }

  /** Takes one credit; false once the flow closed or `signal` aborted. */
  async acquire(signal: AbortSignal | undefined): Promise<boolean> {
    for (;;) {
      if (this.#closed || signal?.aborted === true) return false;
      if (this.#credits > 0) {
        this.#credits -= 1;
        return true;
      }
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        this.#wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      this.#wake = null;
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/** One per connection: the flows its iterators are gated by. */
export class FlowRegistry {
  readonly #flows = new Map<string, Flow>();
  #closed = false;

  /** Open flows; a leak shows as a count that never comes back down. */
  get size(): number {
    return this.#flows.size;
  }

  open(flow: string, window: number): Flow {
    this.#flows.get(flow)?.close();
    const opened = new Flow(window);
    if (this.#closed) opened.close();
    else this.#flows.set(flow, opened);
    return opened;
  }

  release(flow: string, opened: Flow): void {
    opened.close();
    if (this.#flows.get(flow) === opened) this.#flows.delete(flow);
  }

  ack(message: FlowAck): void {
    for (const entry of message.acks) {
      if (!Array.isArray(entry)) continue;
      const [flow, consumed] = entry;
      if (typeof flow !== "string" || typeof consumed !== "number") continue;
      if (!Number.isInteger(consumed) || consumed < 1) continue;
      this.#flows.get(flow)?.grant(consumed);
    }
  }

  /** The connection closed: release every parked iterator. */
  close(): void {
    this.#closed = true;
    for (const flow of this.#flows.values()) flow.close();
    this.#flows.clear();
  }
}

/** Where the server interceptor finds the connection's registry. */
export const FLOW_CONTEXT_KEY = "rpcFlows";

export interface FlowContext {
  [FLOW_CONTEXT_KEY]?: FlowRegistry;
}

const gated = (
  inner: AsyncIterator<unknown, unknown, unknown>,
  flows: FlowRegistry,
  flow: string,
  opened: Flow,
  signal: AbortSignal | undefined
): AsyncIterator<unknown, unknown, unknown> & AsyncIterable<unknown> => {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    flows.release(flow, opened);
  };
  return {
    async next() {
      if (!(await opened.acquire(signal))) {
        release();
        // The consumer is gone: run the procedure's `finally`.
        await inner.return?.();
        return { done: true, value: undefined };
      }
      try {
        const result = await inner.next();
        if (result.done === true) release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    },
    async return(value?: unknown) {
      release();
      return (await inner.return?.(value)) ?? { done: true, value };
    },
    async throw(error?: unknown) {
      release();
      if (inner.throw != null) return inner.throw(error);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

export interface HandlerInterceptorOptions {
  context: object;
  request: {
    headers: Record<string, string | string[] | undefined>;
    signal?: AbortSignal;
  };
  next: () => Promise<{
    matched: boolean;
    response?: { body?: unknown } | undefined;
  }>;
}

/**
 * The main half: an `RPCHandler` `interceptors` entry. A response whose body
 * is an event iterator, on a connection with a registry and a request with a
 * flow header, is pulled only as the renderer acknowledges.
 */
export const flowControlHandlerInterceptor = async <
  T extends HandlerInterceptorOptions,
>(
  options: T
): Promise<Awaited<ReturnType<T["next"]>>> => {
  const result = await options.next();
  const flows = (options.context as FlowContext)[FLOW_CONTEXT_KEY];
  const header = parseFlowHeader(options.request.headers[FLOW_HEADER]);
  const body = result.response?.body;
  if (
    !result.matched ||
    flows == null ||
    header == null ||
    !isAsyncIteratorObject(body)
  )
    return result as Awaited<ReturnType<T["next"]>>;

  const opened = flows.open(header.flow, header.window);
  return {
    ...result,
    response: {
      ...result.response,
      body: gated(body, flows, header.flow, opened, options.request.signal),
    },
  } as Awaited<ReturnType<T["next"]>>;
};

/* -------------------------------------------------------------------- ports */

type MessageListener = (event: { data: unknown }) => void;

/**
 * The server's port with acknowledgements taken out of the message stream
 * (oRPC's peer would fail to decode them) and handed to `flows`. Keeps the
 * shape oRPC detects: `addEventListener` for DOM and Node ports, `on` for
 * Electron's `MessagePortMain`. Closing the port closes the registry.
 */
export const withFlowAcks = <
  P extends {
    postMessage(message: unknown, transfer?: any): void;
  },
>(
  port: P,
  flows: FlowRegistry
): P => {
  const route =
    (listener: MessageListener): MessageListener =>
    (event) => {
      if (isFlowAck(event?.data)) flows.ack(event.data);
      else listener(event);
    };

  const target = port as unknown as {
    addEventListener?: (type: string, listener: MessageListener) => void;
    on?: (type: string, listener: MessageListener) => void;
  };
  if (typeof target.addEventListener === "function") {
    target.addEventListener("close", () => flows.close());
    const add = target.addEventListener.bind(port);
    return new Proxy(port, {
      get(object, property, receiver) {
        if (property === "addEventListener")
          return (type: string, listener: MessageListener) =>
            add(type, type === "message" ? route(listener) : listener);
        const value: unknown = Reflect.get(object, property, receiver);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }
  target.on?.("close", () => flows.close());
  const on = target.on?.bind(port);
  return new Proxy(port, {
    get(object, property, receiver) {
      if (property === "on")
        return (type: string, listener: MessageListener) =>
          on?.(type, type === "message" ? route(listener) : listener);
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
};
