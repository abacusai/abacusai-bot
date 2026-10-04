const APP_DISPLAY_NAME = "AbacusAI Bot";
import type { HostOperations, HostPlatformOperations } from "./handler";
import { wireHostEvents } from "./handler";
import { runStartupMigrations } from "./migrations/startup";
import type { HostPlatform } from "./platform/capabilities";
import type { RpcDeps } from "./rpc/deps";
import { mainEventBus } from "./rpc/event-bus";
import { createTables } from "./rpc/tables";
import { createEventTrackers } from "./rpc/trackers";
import { ServiceHost } from "./service-host";
import { PrefsStore } from "./services/config/prefs-store";

export interface ComposeHostOptions {
  serviceHost?: ServiceHost;
  hostOps?: HostOperations;
  hostPlatform: HostPlatformOperations;
  appOps?: RpcDeps["app"];
  windows?: RpcDeps["windows"];
  browserRuntime?: RpcDeps["browserRuntime"];
  update?: RpcDeps["update"];
  notch?: RpcDeps["notch"];
  cues?: RpcDeps["cues"];
  platform: HostPlatform;
  prefsStore?: PrefsStore;
  beforeInitialize?: () => void;
  afterInitialize?: () => void;
  afterStart?: (host: HostOperations) => void | Promise<void>;
  getDeps?: () => RpcDeps;
}

export const composeHost = async (options: ComposeHostOptions) => {
  const serviceHost = options.serviceHost ?? new ServiceHost(options.platform);
  await runStartupMigrations(APP_DISPLAY_NAME);
  serviceHost.threadStore.replayHeld();
  options.beforeInitialize?.();
  serviceHost.initialize();
  options.afterInitialize?.();
  serviceHost.start();
  const host = wireHostEvents(
    serviceHost,
    options.hostPlatform,
    options.hostOps
  );
  await options.afterStart?.(host);
  serviceHost.startCronScheduler();
  if (
    options.platform === "web-host" &&
    process.env.ABACUSAI_BOT_DEBUG_SYNC_URL
  )
    serviceHost.startBackgroundSync();
  if (options.getDeps) {
    const deps = options.getDeps();
    return {
      serviceHost,
      deps,
      dispose: async () => {
        deps.tables.dispose();
        serviceHost.stopCronScheduler();
        await serviceHost.dispose();
      },
    };
  }
  const tables = createTables({
    bus: mainEventBus,
    sources: serviceHost,
    prefsStore: options.prefsStore ?? new PrefsStore(),
  });
  const deps: RpcDeps = {
    serviceHost,
    host,
    app: options.appOps,
    windows: options.windows,
    browserRuntime: options.browserRuntime,
    update: options.update,
    notch: options.notch,
    cues: options.cues,
    bus: mainEventBus,
    tables,
    ai: serviceHost.aguiRelay,
    threads: serviceHost.threadStore,
    trackers: createEventTrackers(mainEventBus),
  };
  return {
    serviceHost,
    deps,
    dispose: async () => {
      tables.dispose();
      serviceHost.stopCronScheduler();
      await serviceHost.dispose();
    },
  };
};
