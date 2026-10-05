import { app } from "electron";

import type { HostPlatformOperations } from "../handler";
import { registerLoginItem } from "../login-item";
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
  startAbacusAuth,
  startOpenRouterAuth,
  cancelAbacusAuth,
  openAbacusAuthInBrowser,
  listBrowserSignInProfiles,
  shouldAutoSignIn,
  cancelOpenRouterAuth,
  cancelConnectorConnect,
  cancelAllConnectorConnects,
  clearSignInSession,
  rememberSessionAccount,
  registerLoginItem,
  requestMicrophoneAccess,
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
