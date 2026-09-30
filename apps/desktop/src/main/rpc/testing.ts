/**
 * Test support for the router: fake deps, and a client connected to the real
 * router over a real in-process MessageChannel with the real oRPC adapters.
 * Nothing here imports Electron.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/message-port";

import type { Contract } from "#shared/contract";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";
import type { UpdateStatus } from "#shared/update";

import { UnavailableAguiSource } from "./ai/source";
import type { RpcContext } from "./context";
import type { RpcDeps } from "./deps";
import { MainEventBus } from "./event-bus";
import { rpcHandlerOptions } from "./handler-options";
import { createRouter } from "./router";
import { createEventTrackers } from "./trackers";

/**
 * `impl` as the object, and every other member a function that throws naming
 * itself, so a test fails on the first call it did not expect.
 */
export const stub = <T extends object>(name: string, impl: object = {}): T =>
  new Proxy(impl, {
    get(target, property) {
      if (property in target)
        return (target as Record<PropertyKey, unknown>)[property];
      if (typeof property !== "string" || property === "then") return undefined;
      return () => {
        throw new Error(`${name}.${property} was not faked`);
      };
    },
  }) as T;

export const IDLE_UPDATE_STATUS: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
};

export interface FakeDepsOverrides {
  serviceHost?: object;
  host?: object;
  app?: object;
  browserRuntime?: object;
  update?: Partial<RpcDeps["update"]>;
  rendererState?: Partial<RpcDeps["rendererState"]>;
  windows?: Partial<RpcDeps["windows"]>;
  ai?: RpcDeps["ai"];
  threads?: RpcDeps["threads"];
  bus?: MainEventBus;
}

export const fakeDeps = (overrides: FakeDepsOverrides = {}): RpcDeps => {
  const bus = overrides.bus ?? new MainEventBus();
  return {
    serviceHost: stub("serviceHost", overrides.serviceHost),
    host: stub("host", overrides.host),
    app: stub("app", overrides.app),
    browserRuntime: stub("browserRuntime", overrides.browserRuntime),
    update: stub("update", {
      getStatus: () => IDLE_UPDATE_STATUS,
      ...overrides.update,
    }),
    rendererState: stub("rendererState", overrides.rendererState),
    windows: stub("windows", {
      mainRendererId: () => null,
      contents: () => null,
      state: () => null,
      chrome: () => null,
      reportReady: () => undefined,
      ...overrides.windows,
    }),
    bus,
    ai: overrides.ai ?? new UnavailableAguiSource(),
    ...(overrides.threads == null ? {} : { threads: overrides.threads }),
    trackers: createEventTrackers(bus),
  };
};

export type TestClient = ContractRouterClient<Contract>;

export interface InProcessConnection {
  client: TestClient;
  /** Close the renderer's end, as a reload or a closed window does. */
  closeClient(): void;
  /** Close main's end. */
  closeServer(): void;
}

/** The real router, handler and link over a Node MessageChannel. */
export const connectInProcess = (
  deps: RpcDeps,
  context: Partial<Omit<RpcContext, "deps">> = {}
): InProcessConnection => {
  const { port1: server, port2: renderer } = new MessageChannel();
  const handler = new RPCHandler<RpcContext>(
    createRouter(),
    rpcHandlerOptions()
  );
  handler.upgrade(server, {
    context: {
      transport: "memory",
      webContentsId: 1,
      windowKind: "main",
      ...context,
      deps,
    },
  });
  server.start();

  const link = new RPCLink({
    port: renderer,
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  });
  renderer.start();

  return {
    client: createORPCClient(link),
    closeClient: () => renderer.close(),
    closeServer: () => server.close(),
  };
};
