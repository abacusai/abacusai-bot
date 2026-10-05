import { composeHost } from "#main/compose-host";
import type { HostPlatformOperations } from "#main/handler";
import { CueArbiter } from "#main/notch/cue-arbiter";
import type { RpcDeps } from "#main/rpc/deps";
import { unsupported } from "#main/rpc/errors";
import { mainEventBus } from "#main/rpc/event-bus";
import { createTables } from "#main/rpc/tables";
import { createEventTrackers } from "#main/rpc/trackers";
import { ServiceHost } from "#main/service-host";
import { PrefsStore } from "#main/services/config/prefs-store";

import { createNodeAppOperations } from "./app-operations";
import { createWebAuth } from "./auth-web";
import { HostLease } from "./lease";
import { shutdown } from "./shutdown";

const refuse = (procedure: string) => () => {
  throw unsupported(procedure);
};

/** Native sign-in, login items and local models have no web-host form. */
const nodeHostPlatform: HostPlatformOperations = {
  webAuth: createWebAuth,
  startAbacusAuth: refuse("auth.abacus.start"),
  startOpenRouterAuth: refuse("auth.openRouter.start"),
  cancelAbacusAuth: () => {},
  openAbacusAuthInBrowser: refuse("auth.abacus.openInBrowser"),
  listBrowserSignInProfiles: refuse("auth.abacus.browserProfiles"),
  shouldAutoSignIn: async () => false,
  cancelOpenRouterAuth: () => {},
  cancelConnectorConnect: () => {},
  cancelAllConnectorConnects: () => {},
  clearSignInSession: async () => {},
  rememberSessionAccount: () => {},
  registerLoginItem: () => {},
  relaunch: () => shutdown(75),
  requestMicrophoneAccess: async () => true,
  localModels: {
    state: refuse("localModels.state"),
    install: refuse("localModels.install"),
    cancelInstall: () => {},
    remove: refuse("localModels.remove"),
  },
};

const IDLE_UPDATE = {
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

export const composeNodeHost = async () => {
  const serviceHost = new ServiceHost("web-host");
  const lease = new HostLease(
    () =>
      serviceHost.aguiRelay.busy ||
      serviceHost
        .listRoutineHistories()
        .some(({ id }) =>
          serviceHost
            .listRoutineRuns(id)
            .some((run) => run.outcome === "running")
        )
  );
  const appOps = createNodeAppOperations(lease);
  const host = await composeHost({
    serviceHost,
    hostPlatform: nodeHostPlatform,
  });
  if (process.env.ABACUSAI_BOT_DEBUG_SYNC_URL)
    serviceHost.startBackgroundSync();
  const tables = createTables({
    bus: mainEventBus,
    sources: serviceHost,
    prefsStore: new PrefsStore(),
  });
  const trackers = createEventTrackers(mainEventBus);
  const refuseBrowser = refuse("browser");
  const deps: RpcDeps = {
    serviceHost,
    host,
    app: appOps,
    windows: {
      mainRendererId: () => null,
      contents: () => null,
      state: () => null,
      chrome: () => null,
      reportReady: () => {},
    },
    browserRuntime: {
      materialize: refuseBrowser,
      materializeFile: refuseBrowser,
      present: refuseBrowser,
      navigate: refuseBrowser,
      capture: refuseBrowser,
      hide: refuseBrowser,
      close: refuseBrowser,
      promoteScope: refuseBrowser,
    },
    update: {
      checkForUpdates: async () => refuse("update.check")(),
      installUpdate: async () => refuse("update.install")(),
      getStatus: () => IDLE_UPDATE,
    },
    cues: new CueArbiter({
      windows: {
        mainRendererId: () => null,
        mainFocused: () => false,
        audible: () => null,
        canPlay: () => false,
      },
      onWindowGone: (_id, forget) => forget(),
    }),
    bus: mainEventBus,
    tables,
    ai: serviceHost.aguiRelay,
    threads: serviceHost.threadStore,
    trackers,
  };
  const stopOutput = mainEventBus.listen(
    (event) => event.type === "terminal-output",
    () => lease.terminalOutput()
  );
  return {
    serviceHost,
    deps,
    lease,
    appOps,
    dispose: async () => {
      stopOutput();
      trackers.dispose();
      tables.dispose();
      serviceHost.stopCronScheduler();
      await serviceHost.dispose();
    },
  };
};
