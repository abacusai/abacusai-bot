import {
  createHostOperations,
  type HostPlatformOperations,
} from "#main/handler";
import { emitHostEvent } from "#main/rpc/emit";
import type { ServiceHost } from "#main/service-host";

import { createWebAuth } from "./auth-web";
import { shutdown } from "./shutdown";
import { unsupported } from "./unsupported";
export const nodeHostPlatform: HostPlatformOperations = {
  startAbacusAuth: async () => unsupported("auth.abacus.start"),
  startOpenRouterAuth: async () => unsupported("auth.openRouter.start"),
  cancelAbacusAuth: unsupported,
  openAbacusAuthInBrowser: unsupported,
  listBrowserSignInProfiles: unsupported,
  shouldAutoSignIn: async () => false,
  cancelOpenRouterAuth: unsupported,
  cancelConnectorConnect: () => {},
  cancelAllConnectorConnects: () => {},
  clearSignInSession: async () => {},
  rememberSessionAccount: () => {},
  registerLoginItem: () => {},
  relaunch: () => shutdown(75),
  requestMicrophoneAccess: async () => true,
  localModels: {
    state: unsupported,
    install: async () => unsupported("localModels.install"),
    cancelInstall: unsupported,
    remove: () => unsupported(),
  },
};
export const createNodeHostOperations = (serviceHost: ServiceHost) => {
  const operations = createHostOperations(
    serviceHost,
    emitHostEvent,
    nodeHostPlatform
  );
  return Object.assign(operations, { webAuth: createWebAuth(operations) });
};
