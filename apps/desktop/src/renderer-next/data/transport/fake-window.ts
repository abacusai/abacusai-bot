/**
 * A window-shaped event target for the transport's tests: messages posted to
 * it are delivered to its own listeners on a later turn, as a browser does,
 * with `source` and `ports` set. `preload` stands in for the preload's
 * handshake listener and answers requests the way it would.
 */
import type { HandshakeWindow } from "./message-port";

type Listener = (event: MessageEvent) => void;

export class FakeWindow {
  readonly posted: unknown[] = [];
  readonly listeners = new Set<Listener>();

  addEventListener(_type: string, listener: Listener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: Listener): void {
    this.listeners.delete(listener);
  }

  postMessage(
    data: unknown,
    _origin: string,
    transfer: MessagePort[] = []
  ): void {
    this.posted.push(data);
    queueMicrotask(() => this.deliver(data, transfer));
  }

  /** A message arriving at this window, from `source`. */
  deliver(
    data: unknown,
    ports: MessagePort[] = [],
    source: unknown = this
  ): void {
    const event = { data, ports, source } as unknown as MessageEvent;
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  asWindow(): HandshakeWindow {
    return this as unknown as HandshakeWindow;
  }
}
