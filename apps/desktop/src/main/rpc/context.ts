import type { FlowContext } from "@abacus-ai/contract/contract/flow-control";

import type { RpcDeps } from "./deps";

export type RpcTransportKind = "message-port" | "websocket" | "memory";

export type RpcWindowKind = "main" | "notch" | "dev" | "web";

/**
 * Per connection, fixed when the port or socket is upgraded. `webContentsId`
 * and `windowKind` come from main's own registry, never from the renderer.
 */
export interface RpcContext extends FlowContext {
  transport: RpcTransportKind;
  platform?: import("../platform/capabilities").HostPlatform;
  /** Null over a transport with no window (the WebSocket adapter). */
  webContentsId: number | null;
  windowKind: RpcWindowKind;
  deps: RpcDeps;
}
