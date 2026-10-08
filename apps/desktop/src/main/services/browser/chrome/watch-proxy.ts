/**
 * The proxy an unattended run's browser context sends everything through:
 * the page, its frames and workers, and every redirect hop arrive here as a
 * CONNECT, and only one to the declared port, on a host that resolves to
 * public addresses only, is let through. The vetted address is the one
 * dialled, so a name cannot answer differently the second time.
 */
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as net from "node:net";

import { isNonPublicAddress } from "@abacus-ai/agent/tool-policy";

export interface WatchProxy {
  /** For `Target.createBrowserContext`'s `proxyServer`. */
  server: string;
  close(): Promise<void>;
}

export interface WatchProxyOptions {
  /** The one port the watch page's context may reach. */
  port: number;
  resolve?: (host: string) => Promise<Array<{ address: string }>>;
  /** Replaced by tests, which can only serve on loopback. */
  isPublic?: (address: string) => boolean;
}

/** `host:port` of a CONNECT, brackets off an IPv6 host; null when malformed. */
function connectTarget(raw: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(raw);
  if (match == null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: (match[1] ?? match[2] ?? "").toLowerCase(), port };
}

const refuse = (socket: net.Socket): void => {
  socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
};

export async function startWatchProxy(
  options: WatchProxyOptions
): Promise<WatchProxy> {
  const resolve =
    options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const isPublic =
    options.isPublic ?? ((address: string) => !isNonPublicAddress(address));
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  /** The one address to dial, or null when the host is not public. */
  const vetted = async (host: string): Promise<string | null> => {
    if (net.isIP(host) !== 0) return isPublic(host) ? host : null;
    try {
      const addresses = await resolve(host);
      return addresses.length > 0 &&
        addresses.every(({ address }) => isPublic(address))
        ? addresses[0]!.address
        : null;
    } catch {
      return null;
    }
  };

  const server = http.createServer((_request, response) => {
    // Plain http: a watch page is https, and its context never leaves it.
    response.writeHead(403, { "content-length": "0" }).end();
  });
  server.on("upgrade", (_request, socket: net.Socket) => socket.destroy());
  server.on("connect", (request, socket: net.Socket, head: Buffer) => {
    track(socket);
    socket.on("error", () => socket.destroy());
    const target = connectTarget(request.url ?? "");
    if (target == null || target.port !== options.port) {
      refuse(socket);
      return;
    }
    void vetted(target.host).then((address) => {
      if (address == null || socket.destroyed) {
        if (!socket.destroyed) refuse(socket);
        return;
      }
      const upstream = net.connect({ host: address, port: target.port });
      track(upstream);
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => {
        if (!socket.destroyed)
          socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    });
  });
  server.on("connection", track);

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}
