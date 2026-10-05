import type { HostOperations, HostPlatformOperations } from "./handler";
import { wireHostEvents } from "./handler";
import { runStartupMigrations } from "./migrations/startup";
import type { ServiceHost } from "./service-host";

const APP_DISPLAY_NAME = "AbacusAI Bot";

/**
 * The startup order every host shares: migrations, held-write replay,
 * initialize, start, event wiring, then the cron scheduler. The hooks are
 * where the desktop overlays preferences, restores accounts and installs RPC.
 */
export const composeHost = async (options: {
  serviceHost: ServiceHost;
  hostPlatform: HostPlatformOperations;
  beforeInitialize?: () => void;
  afterInitialize?: () => void;
  afterStart?: (host: HostOperations) => void | Promise<void>;
}): Promise<HostOperations> => {
  const { serviceHost } = options;
  await runStartupMigrations(APP_DISPLAY_NAME);
  serviceHost.threadStore.replayHeld();
  options.beforeInitialize?.();
  serviceHost.initialize();
  options.afterInitialize?.();
  serviceHost.start();
  const host = wireHostEvents(serviceHost, options.hostPlatform);
  await options.afterStart?.(host);
  serviceHost.startCronScheduler();
  return host;
};
