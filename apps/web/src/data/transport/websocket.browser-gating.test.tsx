import { afterEach, expect, it, vi } from "vitest";

import { awaitWebSocketOpen, connectWebSocketTransport } from "./websocket";
class Socket extends EventTarget {
  readyState = 0;
  close = vi.fn();
  send = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    super();
  }
}
afterEach(() => vi.unstubAllGlobals());
it("awaits open and passes the token only as a subprotocol", async () => {
  let socket: Socket;
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols);
        socket = Object.assign(this, {});
      }
    }
  );
  let resolved = false;
  const pending = connectWebSocketTransport("wss://pod/rpc", [
    "abacus-rpc",
    "abacus-token.secret",
  ]).then((value) => {
    resolved = true;
    return value;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(socket!.url).toBe("wss://pod/rpc");
  expect(socket!.protocols).toEqual(["abacus-rpc", "abacus-token.secret"]);
  socket!.readyState = 1;
  socket!.dispatchEvent(new Event("open"));
  const transport = await pending;
  expect(transport.kind).toBe("websocket");
  transport.close();
});
it("reports a handshake error before any boot calls", async () => {
  const socket = new Socket("wss://pod/rpc", []);
  const pending = awaitWebSocketOpen(socket as unknown as WebSocket);
  socket.dispatchEvent(new Event("error"));
  await expect(pending).rejects.toThrow("handshake failed");
  expect(socket.close).toHaveBeenCalledOnce();
});
