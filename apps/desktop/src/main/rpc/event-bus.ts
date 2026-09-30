import type { SystemEvent, WindowEvent } from "#shared/contract";
import type { DeviceStreamChunk, IpcEvent } from "#shared/contracts";
import type { UpdateStatus } from "#shared/update";

/** Pushes that never went through the `IpcEvent` catch-all. */
export interface BusChannels {
  update: UpdateStatus;
  system: SystemEvent;
  /** Scoped to one window by its webContents id. */
  window: { webContentsId: number; event: WindowEvent };
  "device-chunk": DeviceStreamChunk;
  /** A memory file changed (published by sub-slice B's watchers). */
  memory: { type: "changed" };
}

export type BusChannel = keyof BusChannels;

type Listener<T> = (payload: T) => void;

/**
 * Main's event bus (spec 00 A.4.3): one synchronous fan-out of every event
 * main pushes, beside the legacy `sendToRenderer`. It buffers nothing: each
 * subscriber registers a predicate and gets only matching events into its own
 * queue (subscriber-queue.ts), so unrelated traffic can never evict them.
 *
 * Not oRPC's `EventPublisher`: that keeps a bounded buffer per subscriber and
 * drops the oldest events silently, which is wrong for anything that must be
 * delivered.
 *
 * No Electron here: the router and its tests run without it.
 */
export class MainEventBus {
  readonly #ipc = new Set<{
    filter: (event: IpcEvent) => boolean;
    listener: Listener<IpcEvent>;
  }>();
  readonly #channels = new Map<BusChannel, Set<Listener<unknown>>>();

  /** Every `IpcEvent`, as emitIpcEvent sends it to the legacy renderer. */
  dispatch(event: IpcEvent): void {
    for (const entry of Array.from(this.#ipc)) {
      let matches = false;
      try {
        matches = entry.filter(event);
      } catch (error) {
        console.error("[rpc] bus filter threw", error);
      }
      if (matches) this.#deliver(entry.listener, event);
    }
  }

  dispatchChannel<C extends BusChannel>(
    channel: C,
    payload: BusChannels[C]
  ): void {
    for (const listener of Array.from(this.#channels.get(channel) ?? []))
      this.#deliver(listener, payload);
  }

  /** Returns the unsubscribe. */
  listen(
    filter: (event: IpcEvent) => boolean,
    listener: Listener<IpcEvent>
  ): () => void {
    const entry = { filter, listener };
    this.#ipc.add(entry);
    return () => {
      this.#ipc.delete(entry);
    };
  }

  listenChannel<C extends BusChannel>(
    channel: C,
    listener: Listener<BusChannels[C]>
  ): () => void {
    let listeners = this.#channels.get(channel);
    if (listeners == null) {
      listeners = new Set();
      this.#channels.set(channel, listeners);
    }
    const added = listener as Listener<unknown>;
    listeners.add(added);
    return () => {
      listeners.delete(added);
    };
  }

  /** Live subscriptions; a leak shows as a count that never comes back down. */
  listenerCount(): number {
    let count = this.#ipc.size;
    for (const listeners of this.#channels.values()) count += listeners.size;
    return count;
  }

  #deliver<T>(listener: Listener<T>, payload: T): void {
    try {
      listener(payload);
    } catch (error) {
      // One broken subscriber must not starve the rest.
      console.error("[rpc] bus listener threw", error);
    }
  }
}

/** The process's bus; tests make their own. */
export const mainEventBus = new MainEventBus();
