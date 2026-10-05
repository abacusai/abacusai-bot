/**
 * The oRPC transport between main and a renderer window: one MessagePort per
 * page load (spec 00 A.4.2).
 *
 * The preload creates a MessageChannel when the page asks (a nonce
 * handshake, preload/rpc-port.ts) and posts one end here on `rpc:connect`.
 * A port is accepted only from a webContents `wireRendererContents`
 * registered, and only from its main frame; webviews, connector windows and
 * the sign-in window are never registered. At most one port per webContents
 * is live: a new connect closes the previous one, and a reload or a destroyed
 * contents closes it too, which ends every open iterator on it.
 *
 * Listeners are installed once per webContents, at registration, and removed
 * on `destroyed`, so reloads and reconnects add none.
 */
import type { MessagePortMainLike } from "@orpc/client/message-port";
import { RPCHandler } from "@orpc/server/message-port";
import type {
  IpcMain,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
} from "electron";

import {
  FLOW_CONTEXT_KEY,
  FlowRegistry,
  withFlowAcks,
} from "#shared/contract/flow-control";

import type { RpcContext, RpcWindowKind } from "../context";
import type { RpcDeps } from "../deps";
import { rpcHandlerOptions } from "../handler-options";
import type { RendererReadiness } from "../readiness";
import type { AppRouter } from "../router";

export const RPC_CONNECT_CHANNEL = "rpc:connect";

export type RendererKind = Exclude<RpcWindowKind, "dev">;

interface Entry {
  kind: RendererKind;
  port: TrackedPort | null;
  /** Removes the webContents listeners registration installed. */
  teardown: () => void;
}

/**
 * A port whose `close` listeners run exactly once, whichever end closed it.
 * Electron documents `close` for the remote end going away; closing our own
 * end must end the port's iterators just the same, so it runs them itself.
 */
interface TrackedPort {
  readonly port: MessagePortMain;
  /** What oRPC upgrades: the port, with `close` routed through here. */
  readonly peer: MessagePortMainLike;
  close(): void;
}

const trackPort = (port: MessagePortMain): TrackedPort => {
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const notifyClosed = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  port.on("close", notifyClosed);

  return {
    port,
    peer: {
      // Electron refuses an explicit `undefined` transfer list.
      postMessage: (message: unknown, transfer?: MessagePortMain[]) =>
        transfer == null
          ? port.postMessage(message)
          : port.postMessage(message, transfer),
      on: (event, listener) => {
        if (event === "close") closeListeners.push(() => listener());
        else port.on("message", listener);
      },
    },
    close() {
      try {
        port.close();
      } catch {
        // Already closed with its contents.
      }
      notifyClosed();
    },
  };
};

export interface MessagePortTransport {
  /** Trust a renderer webContents; the only way one becomes trusted. */
  registerRendererContents(contents: WebContents, kind: RendererKind): void;
  /** Live ports across every registered webContents (a debug counter). */
  livePorts(): number;
  /** Whether `webContentsId` is registered. */
  isRegistered(webContentsId: number): boolean;
  /** Every registered webContents id: the live view and any swap candidate. */
  registeredIds(kind?: RendererKind): number[];
  unregisterRendererContents(id: number): void;
  dispose(): void;
}

export interface MessagePortTransportOptions {
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  router: AppRouter;
  deps: RpcDeps;
  /** A reload or a destroyed contents forgets its readiness report. */
  readiness?: Pick<RendererReadiness, "forget" | "discard">;
}

export const installMessagePortTransport = ({
  ipcMain,
  router,
  deps,
  readiness,
}: MessagePortTransportOptions): MessagePortTransport => {
  const handler = new RPCHandler<RpcContext>(router, rpcHandlerOptions());
  const registry = new Map<number, Entry>();

  const closeActivePort = (webContentsId: number): void => {
    const entry = registry.get(webContentsId);
    const tracked = entry?.port;
    if (entry == null || tracked == null) return;
    entry.port = null;
    tracked.close();
  };

  const onConnect = (event: IpcMainEvent): void => {
    const [port] = event.ports;
    if (port == null) return;

    const { sender } = event;
    const entry = registry.get(sender.id);
    // Only a registered renderer's main frame; `kind` is ours, not the page's.
    if (
      entry == null ||
      sender.isDestroyed() ||
      event.senderFrame == null ||
      event.senderFrame !== sender.mainFrame
    ) {
      port.close();
      return;
    }

    closeActivePort(sender.id);
    const tracked = trackPort(port);
    entry.port = tracked;
    // A closed port leaves the registry; oRPC aborts its iterators on close.
    tracked.peer.on("close", () => {
      if (entry.port === tracked) entry.port = null;
    });
    // The renderer's acknowledgements gate this port's iterators.
    const flows = new FlowRegistry();
    handler.upgrade(withFlowAcks(tracked.peer, flows), {
      context: {
        transport: "message-port",
        webContentsId: sender.id,
        windowKind: entry.kind,
        deps,
        [FLOW_CONTEXT_KEY]: flows,
      },
    });
    port.start();
  };

  ipcMain.on(RPC_CONNECT_CHANNEL, onConnect);

  return {
    registerRendererContents(contents, kind) {
      if (registry.has(contents.id)) return;
      const id = contents.id;

      // The port the document had when a main-frame, cross-document
      // navigation started. It is closed only once that navigation commits
      // (`did-navigate`): one that never commits (a download, a 204, an
      // abort) leaves the document, and its port, in place. And only if it
      // is still the active one: a new document that already connected has
      // replaced it (closing it then), and its own port must stay.
      let portAtNavigationStart: TrackedPort | null | undefined;
      const onNavigationStart = (
        _event: unknown,
        _url: string,
        isSameDocument: boolean,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame || isSameDocument) return;
        portAtNavigationStart = registry.get(id)?.port ?? null;
      };
      const onNavigationCommit = (): void => {
        // `did-navigate` fires only for a main-frame, cross-document commit.
        const entry = registry.get(id);
        if (entry == null || portAtNavigationStart === undefined) return;
        const previous = portAtNavigationStart;
        portAtNavigationStart = undefined;
        if (entry.port !== previous) return;
        // The old document's iterators end with its port.
        closeActivePort(id);
        readiness?.forget(id);
      };
      const onDestroyed = (): void => {
        closeActivePort(id);
        teardown();
        // Unregistered: a later connect from this id is refused.
        registry.delete(id);
        // A candidate destroyed while its swap waits fails at once.
        readiness?.discard(id);
      };
      const teardown = (): void => {
        contents.off("did-start-navigation", onNavigationStart);
        contents.off("did-navigate", onNavigationCommit);
        contents.off("destroyed", onDestroyed);
      };

      registry.set(id, { kind, port: null, teardown });
      contents.on("did-start-navigation", onNavigationStart);
      contents.on("did-navigate", onNavigationCommit);
      contents.once("destroyed", onDestroyed);
    },

    livePorts() {
      let count = 0;
      for (const entry of registry.values()) if (entry.port != null) count += 1;
      return count;
    },

    isRegistered(webContentsId) {
      return registry.has(webContentsId);
    },

    registeredIds(kind) {
      return [...registry]
        .filter(([, entry]) => kind == null || entry.kind === kind)
        .map(([id]) => id);
    },
    unregisterRendererContents(id) {
      const entry = registry.get(id);
      if (!entry) return;
      closeActivePort(id);
      entry.teardown();
      registry.delete(id);
      readiness?.discard(id);
    },

    dispose() {
      ipcMain.removeListener(RPC_CONNECT_CHANNEL, onConnect);
      for (const [id, entry] of registry) {
        closeActivePort(id);
        // Surviving contents keep nothing that points at this transport.
        entry.teardown();
      }
      registry.clear();
    },
  };
};
