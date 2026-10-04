import { app } from "electron";

import {
  createHostOperations,
  wireHostEvents as wire,
  type HostPlatformOperations,
} from "../handler";
import { registerLoginItem } from "../login-item";
import type { ServiceHost } from "../service-host";
import { LocalModelService } from "../services/local-models/local-model-service";
import {
  cancelAbacusAuth,
  openAbacusAuthInBrowser,
  startAbacusAuth,
} from "../services/providers/abacus-auth-service";
import { listBrowserSignInProfiles } from "../services/providers/abacus-browser-profiles";
import {
  cancelAllConnectorConnects,
  cancelConnectorConnect,
} from "../services/providers/abacus-connector-service";
import { shouldAutoSignIn } from "../services/providers/abacus-signin-config";
import {
  cancelOpenRouterAuth,
  startOpenRouterAuth,
} from "../services/providers/openrouter-auth-service";
import {
  clearSignInSession,
  rememberSessionAccount,
} from "../services/providers/sign-in-session";
import { requestMicrophoneAccess } from "../services/voice/microphone";

let localModels: LocalModelService | null = null;
export const disposeLocalModels = (): void => {
  localModels?.dispose();
  localModels = null;
};
export const electronHostPlatform: HostPlatformOperations = {
  startAbacusAuth: (...args) => startAbacusAuth(...args),
  startOpenRouterAuth: (...args) => startOpenRouterAuth(...args),
  cancelAbacusAuth: (...args) => cancelAbacusAuth(...args),
  openAbacusAuthInBrowser: (...args) => openAbacusAuthInBrowser(...args),
  listBrowserSignInProfiles: (...args) => listBrowserSignInProfiles(...args),
  shouldAutoSignIn: (...args) => shouldAutoSignIn(...args),
  cancelOpenRouterAuth: (...args) => cancelOpenRouterAuth(...args),
  cancelConnectorConnect: (...args) => cancelConnectorConnect(...args),
  cancelAllConnectorConnects: (...args) => cancelAllConnectorConnects(...args),
  clearSignInSession: (...args) => clearSignInSession(...args),
  rememberSessionAccount: (...args) => rememberSessionAccount(...args),
  registerLoginItem: (...args) => registerLoginItem(...args),
  requestMicrophoneAccess: (...args) => requestMicrophoneAccess(...args),
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
  localModels: {
    state: () => localModels?.state(),
    install: (id) =>
      localModels == null
        ? Promise.resolve({
            ok: false,
            error: "local models are not available",
          })
        : localModels.install(id),
    cancelInstall: () => {
      localModels?.cancelInstall();
    },
    remove: (id) => {
      localModels?.remove(id);
    },
  },
};
export const wireHostEvents = (host: ServiceHost) =>
  wire(host, electronHostPlatform);
export { createHostOperations };

export type { HostOperations } from "../handler";
