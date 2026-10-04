import type { FlowContext } from "#shared/contract/flow-control";

import type { RpcDeps } from "./deps";

export type RpcTransportKind = "message-port" | "websocket" | "memory";

/**
 * `web`: a browser tab of the hosted web app. `remote`: the hosted web app
 * reaching this desktop for coding (see main/services/runner).
 */
export type RpcWindowKind = "main" | "notch" | "dev" | "web" | "remote";

/**
 * Per connection, fixed when the port or socket is upgraded. `webContentsId`
 * and `windowKind` come from main's own registry, never from the renderer.
 */
export interface RpcContext extends FlowContext {
  transport: RpcTransportKind;
  /** Null over a transport with no window (the WebSocket adapter). */
  webContentsId: number | null;
  windowKind: RpcWindowKind;
  deps: RpcDeps;
}
