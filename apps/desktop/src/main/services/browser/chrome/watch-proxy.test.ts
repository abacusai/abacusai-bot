/**
 * The proxy an unattended run's browser context goes through: real sockets on
 * loopback, so a test stands in for "public" where it needs a tunnel to open.
 */
import * as http from "node:http";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startWatchProxy, type WatchProxy } from "./watch-proxy";

const open: Array<{ close(): unknown }> = [];

afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

/** The proxy's reply to a CONNECT, and the socket for what follows. */
async function connect(
  proxy: WatchProxy,
  target: string
): Promise<{ status: string; socket: net.Socket }> {
  const { port } = new URL(proxy.server);
  const socket = net.connect(Number(port), "127.0.0.1");
  await new Promise((done) => socket.once("connect", done));
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const reply = await new Promise<string>((done) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n\r\n")) {
        socket.off("data", onData);
        done(text);
      }
    };
    socket.on("data", onData);
    socket.once("close", () => done(text));
  });
  return { status: reply.split("\r\n")[0] ?? "", socket };
}

const started = async (
  options: Parameters<typeof startWatchProxy>[0]
): Promise<WatchProxy> => {
  const proxy = await startWatchProxy(options);
  open.push(proxy);
  return proxy;
};

describe("the watch proxy", () => {
  it("refuses a name that resolves inside, before anything is sent", async () => {
    const proxy = await started({
      port: 443,
      resolve: async () => [{ address: "10.0.0.5" }],
    });
    const { status, socket } = await connect(proxy, "shop.example:443");
    socket.destroy();
    expect(status).toContain("403");
  });

  it("refuses a name with any inside address among its answers", async () => {
    const proxy = await started({
      port: 443,
      resolve: async () => [
        { address: "93.184.216.34" },
        { address: "169.254.169.254" },
      ],
    });
    const { status, socket } = await connect(proxy, "shop.example:443");
    socket.destroy();
    expect(status).toContain("403");
  });

  it.each([
    "127.0.0.1:443",
    "[::1]:443",
    "169.254.169.254:443",
    "10.1.2.3:443",
  ])("refuses an inside address spelled out: %s", async (target) => {
    const proxy = await started({ port: 443 });
    const { status, socket } = await connect(proxy, target);
    socket.destroy();
    expect(status).toContain("403");
  });

  it("refuses any port but the declared one", async () => {
    const proxy = await started({
      port: 443,
      resolve: async () => [{ address: "93.184.216.34" }],
    });
    const { status, socket } = await connect(proxy, "shop.example:8443");
    socket.destroy();
    expect(status).toContain("403");
  });

  it("refuses plain http and websocket upgrades", async () => {
    const proxy = await started({ port: 80 });
    const status = await new Promise<number>((done, fail) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: Number(new URL(proxy.server).port),
          path: "http://shop.example/",
          headers: { host: "shop.example" },
        },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        }
      );
      request.on("error", fail);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("tunnels to a public host on the declared port, dialling the vetted address", async () => {
    const upstream = net.createServer((socket) =>
      socket.on("data", (chunk) => socket.write(`echo:${chunk}`))
    );
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    open.push({ close: () => new Promise((done) => upstream.close(done)) });
    const port = (upstream.address() as net.AddressInfo).port;
    const asked: string[] = [];
    const proxy = await started({
      port,
      resolve: async (host) => {
        asked.push(host);
        return [{ address: "127.0.0.1" }];
      },
      isPublic: () => true,
    });
    const { status, socket } = await connect(proxy, `shop.example:${port}`);
    expect(status).toContain("200");
    socket.write("ping");
    const echoed = await new Promise<string>((done) =>
      socket.once("data", (chunk) => done(chunk.toString()))
    );
    socket.destroy();
    expect(echoed).toBe("echo:ping");
    expect(asked).toEqual(["shop.example"]);
  });
});
