/**
 * The same router over a WebSocket (spec 00 A.8), for development smoke tests
 * only: it proves nothing in the router is Electron-bound. Not wired into the
 * app. Loopback only, and every connection must carry the random token.
 *
 * Window-scoped procedures (`window.*`) answer `FORBIDDEN` here: a socket has
 * no window.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  FLOW_CONTEXT_KEY,
  FlowRegistry,
  isFlowAck,
} from "@abacus-ai/contract/contract/flow-control";
import { RPCHandler } from "@orpc/server/ws";
import {
  WebSocketServer,
  type VerifyClientCallbackAsync,
  type WebSocket,
} from "ws";

import type { RpcContext } from "../context";
import type { RpcDeps } from "../deps";
import { rpcHandlerOptions } from "../handler-options";
import type { AppRouter } from "../router";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Grammar consumed by oRPC's request decoder (omitted t means request). */
export const isRpcRequestFrame = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.i !== "string") return false;
  if (Object.keys(value).some((key) => !["i", "t", "p"].includes(key)))
    return false;
  if (value.t !== undefined && ![1, 2, 3, 4].includes(value.t as number))
    return false;
  if (value.t === 4) return value.p === undefined;
  if (!isRecord(value.p)) return false;
  const payload = value.p;
  if (value.t === 3)
    return (
      ["message", "error", "done"].includes(payload.e as string) &&
      Object.keys(payload).every((key) => ["e", "d", "m"].includes(key)) &&
      (payload.m === undefined || isRecord(payload.m))
    );
  if (
    typeof payload.u !== "string" ||
    Object.keys(payload).some((key) => !["u", "b", "h", "m"].includes(key)) ||
    (payload.h !== undefined && !isRecord(payload.h)) ||
    (payload.m !== undefined && typeof payload.m !== "string")
  )
    return false;
  try {
    new URL(payload.u, payload.u.startsWith("/") ? "http://orpc" : undefined);
    return true;
  } catch {
    return false;
  }
};

export interface WebSocketTransport {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const sameToken = (given: string | null, expected: string): boolean => {
  if (given == null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const startWebSocketTransport = async ({
  router,
  deps,
  host = "127.0.0.1",
  port = 0,
  token = randomBytes(24).toString("hex"),
  verifyClient,
  flowControl = false,
  httpServer,
  platform = "electron",
}: {
  router: AppRouter;
  deps: RpcDeps;
  host?: string;
  verifyClient?: VerifyClientCallbackAsync;
  flowControl?: boolean;
  httpServer?: Server;
  platform?: RpcContext["platform"];
  port?: number;
  token?: string;
}): Promise<WebSocketTransport> => {
  const handler = new RPCHandler<RpcContext>(router, rpcHandlerOptions());
  const server = new WebSocketServer({
    ...(httpServer ? { server: httpServer } : { host, port }),
    verifyClient,
    ...(verifyClient
      ? {
          handleProtocols: (protocols) =>
            protocols.has("abacus-rpc") ? "abacus-rpc" : false,
        }
      : {}),
    maxPayload: flowControl ? 1024 * 1024 : undefined,
  });

  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!verifyClient && !sameToken(url.searchParams.get("token"), token)) {
      socket.close(1008, "token required");
      return;
    }
    if (flowControl) {
      const send = socket.send.bind(socket);
      socket.send = ((
        data: Parameters<typeof socket.send>[0],
        ...args: unknown[]
      ) => {
        const size =
          typeof data === "string"
            ? Buffer.byteLength(data)
            : (data as Buffer).byteLength;
        if (size > 1024 * 1024) {
          socket.close(1009, "outbound payload too large");
          return;
        }
        return (send as Function)(data, ...args);
      }) as typeof socket.send;
    }
    const flows = flowControl ? new FlowRegistry() : undefined;
    // A stalled consumer is cut off rather than buffered without bound.
    const timer = flowControl
      ? setInterval(() => {
          if (socket.bufferedAmount > 16 * 1024 * 1024)
            socket.close(1013, "consumer stalled");
        }, 100)
      : undefined;
    socket.once("close", () => {
      clearInterval(timer);
      flows?.close();
    });
    // Acknowledgements go to the registry; anything else must be an oRPC
    // request frame. Binary frames that are not JSON pass through unchanged.
    const onMessage =
      (listener: (event: WebSocket.MessageEvent) => void) =>
      (event: WebSocket.MessageEvent) => {
        try {
          const decoded = JSON.parse(event.data.toString());
          if (isFlowAck(decoded)) {
            flows?.ack(decoded);
            return;
          }
          if (!isRpcRequestFrame(decoded)) {
            socket.close(1008, "malformed RPC frame");
            return;
          }
        } catch {
          if (typeof event.data === "string") {
            socket.close(1008, "malformed RPC frame");
            return;
          }
        }
        listener(event);
      };
    const rpcSocket = flows
      ? new Proxy(socket, {
          get(target, key) {
            if (key === "addEventListener")
              return (
                type: "message",
                listener: (event: WebSocket.MessageEvent) => void
              ) =>
                target.addEventListener(
                  type,
                  type === "message" ? onMessage(listener) : listener
                );
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : socket;
    handler.upgrade(rpcSocket, {
      context: {
        transport: "websocket",
        webContentsId: null,
        windowKind: platform === "web-host" ? "web" : "dev",
        platform,
        ...(flows ? { [FLOW_CONTEXT_KEY]: flows } : {}),
        deps,
      },
    });
  });

  if (httpServer && !httpServer.listening) httpServer.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    if (httpServer?.listening) {
      resolve();
      return;
    }
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const bound = (server.address() as AddressInfo).port;
  return {
    url: `ws://${host === "::1" ? "[::1]" : host}:${bound}/?token=${token}`,
    port: bound,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
};
