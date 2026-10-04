/**
 * Test support for the router: fake deps, and a client connected to the real
 * router over a real in-process MessageChannel with the real oRPC adapters.
 * Nothing here imports Electron.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/message-port";

import type { Contract } from "@abacus-ai/contract/contract";
import {
  createFlowControlLinkInterceptor,
  FLOW_CONTEXT_KEY,
  FlowRegistry,
  withFlowAcks,
} from "@abacus-ai/contract/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import type { UpdateStatus } from "@abacus-ai/contract/update";

import { CueArbiter, mainOnlyCueWindows } from "../notch/cue-arbiter";
import { PrefsStore } from "../services/config/prefs-store";
import { UnavailableAguiSource } from "./ai/source";
import type { RpcContext } from "./context";
import type { RpcDeps } from "./deps";
import { MainEventBus } from "./event-bus";
import { rpcHandlerOptions } from "./handler-options";
import { createRouter } from "./router";
import { createTables, type Tables } from "./tables";
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
  failedPhase: null,
};

export interface FakeDepsOverrides {
  serviceHost?: object;
  host?: object;
  app?: object;
  browserRuntime?: object;
  update?: Partial<RpcDeps["update"]>;
  windows?: Partial<RpcDeps["windows"]>;
  ai?: RpcDeps["ai"];
  threads?: RpcDeps["threads"];
  bus?: MainEventBus;
  tables?: Tables;
  prefsStore?: PrefsStore;
  cues?: CueArbiter;
}

const noHook = (): (() => void) => () => undefined;

/** The table hooks a fake service host does not care about. */
const TABLE_HOOKS = {
  onSessionsChanged: noHook,
  onBotsWritten: noHook,
  onRoutinesWritten: noHook,
  onWorkspacesChanged: noHook,
  // Checkouts (spec 04 §26.4): none watched, no fingerprints.
  onCheckoutRowsChanged: noHook,
  checkoutRows: () => [],
  wantGitFingerprints: noHook,
  activeCheckoutKey: () => null,
  checkouts: stub("serviceHost.checkouts", { onTreeChanged: noHook }),
};

export const fakeDeps = (overrides: FakeDepsOverrides = {}): RpcDeps => {
  const bus = overrides.bus ?? new MainEventBus();
  const serviceHost = stub<RpcDeps["serviceHost"]>("serviceHost", {
    ...TABLE_HOOKS,
    ...overrides.serviceHost,
  });
  const tables =
    overrides.tables ??
    createTables({
      bus,
      sources: serviceHost,
      prefsStore: overrides.prefsStore ?? new PrefsStore({ file: null }),
      watchMemories: false,
      routinesClockMs: null,
    });
  const windows = stub<RpcDeps["windows"]>("windows", {
    mainRendererId: () => null,
    contents: () => null,
    state: () => null,
    chrome: () => null,
    reportReady: () => undefined,
    ...overrides.windows,
  });
  return {
    serviceHost,
    host: stub("host", overrides.host),
    app: stub("app", overrides.app),
    browserRuntime: stub("browserRuntime", overrides.browserRuntime),
    update: stub("update", {
      getStatus: () => IDLE_UPDATE_STATUS,
      ...overrides.update,
    }),
    windows,
    bus,
    ai: overrides.ai ?? new UnavailableAguiSource(),
    tables,
    ...(overrides.threads == null ? {} : { threads: overrides.threads }),
    trackers: createEventTrackers(bus),
    cues:
      overrides.cues ??
      new CueArbiter({ windows: mainOnlyCueWindows(windows) }),
  };
};

export type TestClient = ContractRouterClient<Contract>;

export interface InProcessConnection {
  client: TestClient;
  /** The connection's flow registry (open flows, for leak checks). */
  flows: FlowRegistry;
  /** Close the renderer's end, as a reload or a closed window does. */
  closeClient(): void;
  /** Close main's end. */
  closeServer(): void;
}

export interface ConnectInProcessOptions {
  /** Gate iterators on the link's acknowledgements, as main's port does. */
  flowControl?: boolean;
  /** Events the server may send ahead of the consumer. */
  flowWindow?: number;
  /** Sees every message the server posts, as the renderer receives it. */
  onServerMessage?: (message: unknown) => void;
}

/**
 * The real router, handler and link over a Node MessageChannel, with the
 * same flow control as main's MessagePort transport.
 */
export const connectInProcess = (
  deps: RpcDeps,
  context: Partial<Omit<RpcContext, "deps">> = {},
  options: ConnectInProcessOptions = {}
): InProcessConnection => {
  const { port1: server, port2: renderer } = new MessageChannel();
  const handler = new RPCHandler<RpcContext>(
    createRouter(),
    rpcHandlerOptions()
  );
  const flowControl = options.flowControl !== false;
  const flows = new FlowRegistry();
  const observe = options.onServerMessage;
  const serverPort =
    observe == null
      ? server
      : new Proxy(server, {
          get(target, property, receiver) {
            if (property === "postMessage")
              return (
                message: unknown,
                transfer?: Parameters<MessagePort["postMessage"]>[1]
              ) => {
                observe(message);
                target.postMessage(message, transfer);
              };
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  handler.upgrade(flowControl ? withFlowAcks(serverPort, flows) : serverPort, {
    context: {
      transport: "memory",
      webContentsId: 1,
      windowKind: "main",
      ...context,
      deps,
      ...(flowControl ? { [FLOW_CONTEXT_KEY]: flows } : {}),
    },
  });
  server.start();

  const link = new RPCLink({
    port: renderer,
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    clientInterceptors: flowControl
      ? [
          createFlowControlLinkInterceptor(
            (ack) => renderer.postMessage(ack),
            options.flowWindow
          ),
        ]
      : [],
  });
  renderer.start();

  return {
    client: createORPCClient(link),
    flows,
    closeClient: () => renderer.close(),
    closeServer: () => server.close(),
  };
};
