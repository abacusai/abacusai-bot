/**
 * What every transport's `RPCHandler` is built with: the Uint8Array
 * serializer and one interceptor that maps thrown errors onto the contract's
 * error map, logs them, and flags slow calls.
 */
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

export const rpcClientInterceptor = async ({
  next,
  path,
  input,
}: InterceptorOptions): Promise<unknown> => {
  const started = performance.now();
  try {
    return await next();
  } catch (error) {
    const rpcError = toRpcError(error);
    logRpcError(path, rpcError, input);
    throw rpcError;
  } finally {
    const elapsed = performance.now() - started;
    if (elapsed > SLOW_CALL_MS)
      console.warn(`[rpc] slow ${path.join(".")} ${Math.round(elapsed)}ms`);
  }
};

export const rpcHandlerOptions = () => ({
  customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  clientInterceptors: [rpcClientInterceptor],
});

export type { RpcContext };
