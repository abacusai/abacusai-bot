import { contract } from "@abacus-ai/contract/contract";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
/**
 * What every procedures/<domain>.ts shares: the implementer bound to the
 * contract and the RPC context, the window guards, and the one helper every
 * event iterator is built from.
 */
import {
  ORPCError,
  implement,
  type ImplementerInternalWithMiddlewares,
} from "@orpc/server";

import { supportsProcedure } from "../../platform/capabilities";
import { openHostFile } from "../../services/workspace/host-path";
import type { RpcContext } from "../context";
import { DELIVERY, type StreamPath } from "../delivery";
import { forbidden, unsupported } from "../errors";
import type { BusChannel, BusChannels } from "../event-bus";
import { rpcPayloadSize } from "../payload-size";
import { SubscriberQueue } from "../subscriber-queue";

export const impl: ImplementerInternalWithMiddlewares<
  typeof contract,
  RpcContext,
  RpcContext
> = implement(contract)
  .$context<RpcContext>()
  .use(async ({ context, path, next }, input) => {
    const procedure = path.join(".");
    if (!supportsProcedure(context.platform ?? "electron", procedure, input))
      throw unsupported(procedure);
    const fileInput = input as
      | { hostRoot?: string; filePath?: string; maxBytes?: number }
      | undefined;
    const alternative =
      fileInput?.hostRoot && fileInput.filePath
        ? `/files?${new URLSearchParams({ hostRoot: fileInput.hostRoot, path: fileInput.filePath })}`
        : "/files?hostRoot=<workspace>&path=<export-file>";
    const tooLarge = () =>
      new ORPCError("PAYLOAD_TOO_LARGE", {
        status: 413,
        data: { limit: 1024 * 1024, alternative },
      });
    if (
      context.platform === "web-host" &&
      ["files.readText", "files.readImageAsDataUrl", "files.readPptx"].includes(
        procedure
      ) &&
      fileInput?.hostRoot &&
      fileInput.filePath
    ) {
      const file = await openHostFile(fileInput.filePath, fileInput.hostRoot);
      if (file.ok) {
        const size =
          procedure === "files.readText"
            ? Math.min(file.stat.size, fileInput.maxBytes ?? 524288)
            : file.stat.size;
        const cap =
          procedure === "files.readImageAsDataUrl" ? 675 * 1024 : 900 * 1024;
        if (size > cap) throw tooLarge();
      }
    }
    const result = await next({ context: {} });
    if (context.platform !== "web-host") return result;
    const check = async (value: unknown) => {
      // Reserve space for oRPC framing and serializer metadata.
      if ((await rpcPayloadSize(value, 900 * 1024)) > 900 * 1024)
        throw tooLarge();
      return value;
    };
    const output = result.output;
    if (
      output &&
      typeof output === "object" &&
      Symbol.asyncIterator in output
    ) {
      const inner = output as AsyncIterable<unknown>;
      return {
        ...result,
        output: (async function* () {
          for await (const value of inner) yield await check(value);
        })(),
      };
    }
    await check(output);
    return result;
  });

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
