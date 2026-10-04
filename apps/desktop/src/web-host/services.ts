import { wireHostEvents } from "#main/handler";
import { CueArbiter, mainOnlyCueWindows } from "#main/notch/cue-arbiter";
import { abacusBotHome } from "#main/paths";
import type { AppOperations, RpcDeps } from "#main/rpc/deps";
import { mainEventBus, type MainEventBus } from "#main/rpc/event-bus";
import { rpcClientInterceptor } from "#main/rpc/handler-options";
import { procedurePolicyInterceptor } from "#main/rpc/procedure-policy";
import { tabHost, tabWindows } from "#main/rpc/remote-tab";
import { createRouter, type AppRouter } from "#main/rpc/router";
import { createTables } from "#main/rpc/tables";
import { createEventTrackers } from "#main/rpc/trackers";
import { ServiceHost } from "#main/service-host";
import { PrefsStore } from "#main/services/config/prefs-store";
import {
  readAccountState,
  skipOnboarding,
} from "#main/services/providers/account-service";
import { flowControlHandlerInterceptor } from "#shared/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";
/**
 * The desktop's services and router, assembled for one hosted user: the same
 * `ServiceHost`, tables, AG-UI relay and handlers the desktop's main process
 * builds in main/index.ts, with the Electron-only parts (windows, the notch,
 * the updater, the browser runtime, native dialogs) left out. Their procedures
 * are refused by the web policy before they could be reached.
 */
import type { UpdateStatus } from "#shared/update";

import { webCapabilities } from "./capabilities";
import { WEB_PROCEDURES } from "./policy";

const IDLE_UPDATE_STATUS: UpdateStatus = {
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

const unavailable = (what: string): never => {
  throw new Error(`${what} is not available in the web app`);
};

/** The desktop's window-level operations, as far as a server can do them. */
const webAppOperations = (
  bus: MainEventBus,
  version: string
): AppOperations => ({
  openFolderDialog: () => unavailable("Choosing a folder"),
  openFilesDialog: () => unavailable("Choosing files"),
  openExternal: (url) => {
    bus.dispatchChannel("system", { type: "open-url", url });
    return Promise.resolve();
  },
  openFilePath: () => unavailable("Opening files"),
  showItemInFolder: () => undefined,
  appVersion: () => version,
  homeDir: () => abacusBotHome(),
  botHome: () => abacusBotHome(),
  restartApp: () => undefined,
  hasGoogleChrome: () => false,
  reportFunnelStep: () => undefined,
  // Signing in and out belong to the website's session, not to this host.
  account: {
    get: () => readAccountState(),
    skip: () => skipOnboarding(),
    signOut: () => readAccountState(),
    forget: () => readAccountState(),
  },
  savePastedTempFiles: () =>
    Promise.resolve({ success: false, error: "Not available in the web app" }),
  saveLogs: () =>
    Promise.resolve({ success: false, error: "Not available in the web app" }),
  appendLogs: (lines) => {
    if (Array.isArray(lines))
      for (const line of lines) console.log(`[renderer] ${String(line)}`);
  },
  showNotification: () => undefined,
  readImageAsDataUrl: () =>
    Promise.resolve({ success: false, error: "Not available in the web app" }),
  readFileAsText: () =>
    Promise.resolve({ success: false, error: "Not available in the web app" }),
  readPptx: () => unavailable("Reading presentations"),
  importLocalSkills: () => unavailable("Importing skills"),
  showAboutPanel: () => undefined,
  setTitlebarDensity: () => unavailable("Window density"),
  loginItem: {
    get: () => ({ openAtLogin: false }),
    set: () => ({ openAtLogin: false }),
  },
  markRendererActivity: () => undefined,
});

export interface HostServices {
  router: AppRouter;
  handlerOptions: ReturnType<typeof webHandlerOptions>;
  deps: RpcDeps;
  bus: MainEventBus;
  /** An agent run is in flight; the gateway keeps us alive while it is. */
  busy(): boolean;
  /** The user's desktop attached or left as a coding runner. */
  setRunnerAttached(attached: boolean): void;
  dispose(): Promise<void>;
}

/** As main's `rpcHandlerOptions`, with the web allowlist checked first. */
const webHandlerOptions = () => ({
  customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  interceptors: [flowControlHandlerInterceptor],
  clientInterceptors: [
    rpcClientInterceptor,
    procedurePolicyInterceptor(WEB_PROCEDURES),
  ],
});

export const createServices = async (): Promise<HostServices> => {
  const version = process.env.ABACUSAI_BOT_WEB_VERSION ?? "web";
  const serviceHost = new ServiceHost();
  serviceHost.threadStore.replayHeld();
  serviceHost.initialize();
  serviceHost.start();
  // `settings.get` hands the renderer the settings file, keys included. The
  // web host's key must never reach a browser: tabs see only that one is set.
  const host = tabHost(wireHostEvents(serviceHost));

  const prefsStore = new PrefsStore();
  let runnerAttached = false;
  // Each browser tab is a "window" with its own id (host.ts).
  const windows = tabWindows();
  const noBrowser = new Proxy(
    {},
    { get: () => () => unavailable("The built-in browser") }
  ) as RpcDeps["browserRuntime"];

  const deps: RpcDeps = {
    serviceHost,
    host,
    app: webAppOperations(mainEventBus, version),
    browserRuntime: noBrowser,
    update: {
      checkForUpdates: () => Promise.resolve({ success: true }),
      installUpdate: () =>
        Promise.resolve({ success: false, error: "Not available" }),
      getStatus: () => IDLE_UPDATE_STATUS,
    },
    windows,
    bus: mainEventBus,
    tables: createTables({
      bus: mainEventBus,
      sources: serviceHost,
      prefsStore,
    }),
    ai: serviceHost.aguiRelay,
    threads: serviceHost.threadStore,
    trackers: createEventTrackers(mainEventBus),
    cues: new CueArbiter({ windows: mainOnlyCueWindows(windows) }),
    capabilities: () => webCapabilities({ runnerAttached }),
  };

  return {
    router: createRouter(),
    handlerOptions: webHandlerOptions(),
    deps,
    bus: mainEventBus,
    busy: () => serviceHost.aguiRelay.busy,
    setRunnerAttached: (attached) => {
      if (attached === runnerAttached) return;
      runnerAttached = attached;
      mainEventBus.dispatchChannel("system", {
        type: "capabilities-changed",
        capabilities: webCapabilities({ runnerAttached }),
      });
    },
    dispose: async () => {
      deps.tables.dispose();
      await serviceHost.dispose();
    },
  };
};
