/**
 * What every transport's `RPCHandler` is built with: the Uint8Array
 * serializer, flow control, and one interceptor that maps thrown errors onto
 * the contract's error map, logs them, and flags slow calls. The mapping
 * covers event iterators too: oRPC consumes a returned iterator after the
 * interceptor has returned, so its errors (a failed snapshot on the first
 * read, a failure after the first yield) are mapped where they are thrown.
 */
import { flowControlHandlerInterceptor } from "#shared/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import type { RpcContext } from "./context";
import { logRpcError, toRpcError } from "./errors";

/** A call slower than this is logged; long-running sign-ins are expected to trip it. */
export const SLOW_CALL_MS = 2_000;

interface InterceptorOptions {
  next: () => Promise<unknown>;
  path: readonly string[];
  input: unknown;
}

const isAsyncIteratorObject = (
  value: unknown
): value is AsyncIterator<unknown, unknown, unknown> & AsyncIterable<unknown> =>
  typeof value === "object" &&
  value != null &&
  typeof (value as { next?: unknown }).next === "function" &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ] === "function";

/** `inner`, with whatever it throws mapped and logged as a call's error is. */
export const mappingIteratorErrors = (
  inner: AsyncIterator<unknown, unknown, unknown>,
  report: (error: unknown) => unknown
): AsyncIterator<unknown, unknown, unknown> & AsyncIterable<unknown> => ({
  async next() {
    try {
      return await inner.next();
    } catch (error) {
      throw report(error);
    }
  },
  async return(value?: unknown) {
    try {
      return (await inner.return?.(value)) ?? { done: true, value };
    } catch (error) {
      throw report(error);
    }
  },
  async throw(error?: unknown) {
    if (inner.throw == null) throw error;
    try {
      return await inner.throw(error);
    } catch (thrown) {
      throw report(thrown);
    }
  },
  [Symbol.asyncIterator]() {
    return this;
  },
});

export const rpcClientInterceptor = async ({
  next,
  path,
  input,
}: InterceptorOptions): Promise<unknown> => {
  const started = performance.now();
  const report = (error: unknown) => {
    const rpcError = toRpcError(error);
    logRpcError(path, rpcError, input);
    return rpcError;
  };
  try {
    const output = await next();
    return isAsyncIteratorObject(output)
      ? mappingIteratorErrors(output, report)
      : output;
  } catch (error) {
    throw report(error);
  } finally {
    const elapsed = performance.now() - started;
    if (elapsed > SLOW_CALL_MS)
      console.warn(`[rpc] slow ${path.join(".")} ${Math.round(elapsed)}ms`);
  }
};

export const rpcHandlerOptions = () => ({
  customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  // Pulls iterators only as far ahead as the renderer has consumed, on a
  // connection that carries a flow registry (the MessagePort transport).
  interceptors: [flowControlHandlerInterceptor],
  clientInterceptors: [rpcClientInterceptor],
});

export type { RpcContext };
