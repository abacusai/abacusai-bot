/**
 * The same router over a WebSocket (spec 00 A.8), for development smoke tests
 * only: it proves nothing in the router is Electron-bound. Not wired into the
 * app. Loopback only, and every connection must carry the random token.
 *
 * Window-scoped procedures (`window.*`) answer `FORBIDDEN` here: a socket has
 * no window.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import { RPCHandler } from "@orpc/server/ws";
import { WebSocketServer } from "ws";

import type { RpcContext } from "../context";
import type { RpcDeps } from "../deps";
import { rpcHandlerOptions } from "../handler-options";
import type { AppRouter } from "../router";

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
}: {
  router: AppRouter;
  deps: RpcDeps;
  host?: "127.0.0.1" | "::1";
  port?: number;
  token?: string;
}): Promise<WebSocketTransport> => {
  const handler = new RPCHandler<RpcContext>(router, rpcHandlerOptions());
  const server = new WebSocketServer({ host, port });

  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!sameToken(url.searchParams.get("token"), token)) {
      socket.close(1008, "token required");
      return;
    }
    handler.upgrade(socket, {
      context: {
        transport: "websocket",
        webContentsId: null,
        windowKind: "dev",
        deps,
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
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
