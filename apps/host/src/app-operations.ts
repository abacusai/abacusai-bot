import { homedir } from "node:os";

import { isFunnelStep, funnelDetail } from "@abacus-ai/contract/funnel";

import { nodeFileOperations } from "#main/app-operations/node";
import { abacusBotHome } from "#main/paths";
import type { AppOperations } from "#main/rpc/deps";
import { emitBusChannel } from "#main/rpc/emit";
import { unsupported } from "#main/rpc/errors";
import {
  reportFunnelStep,
  reportFunnelStepOnce,
} from "#main/services/debug-sync/funnel-beacon";
import {
  readAccountState,
  skipOnboarding,
  signOut,
  forgetAccount,
} from "#main/services/providers/account-service";
import { setTitlebarDensity } from "#main/window-chrome-settings";

import { listDirectory, makeDirectory } from "./directories";
import { app } from "./electron-shim";
import type { HostLease } from "./lease";
import { shutdown } from "./shutdown";
const refuse = (procedure: string) => async () => {
  throw unsupported(procedure);
};

export const createNodeAppOperations = (lease: HostLease): AppOperations => ({
  ...nodeFileOperations,
  listDirectory,
  mkdir: makeDirectory,
  openFolderDialog: async () => null,
  openFilesDialog: async () => null,
  openExternal: refuse("system.openExternal"),
  openFilePath: async () => ({ outcome: "refused", reason: "outside" }),
  showItemInFolder: () => {},
  appVersion: app.getVersion,
  homeDir: homedir,
  botHome: abacusBotHome,
  restartApp: () => shutdown(75),
  reportFunnelStep: (step, detail, once) => {
    if (isFunnelStep(step))
      (once ? reportFunnelStepOnce : reportFunnelStep)(
        step,
        funnelDetail(detail)
      );
  },
  account: {
    get: readAccountState,
    skip: skipOnboarding,
    signOut,
    forget: forgetAccount,
  },
  saveLogs: refuse("system.saveLogs"),
  showNotification: (title, body, metadata) =>
    emitBusChannel("system", { type: "notification", title, body, metadata }),
  // No native picker: the browser imports skills by upload.
  importLocalSkills: async () => ({ success: false, cancelled: true }),
  showAboutPanel: () => {
    throw unsupported("system.about");
  },
  setTitlebarDensity: async (value) => ({
    density: setTitlebarDensity(value),
    appliesOnRestart: false,
  }),
  loginItem: {
    get: () => ({ openAtLogin: false }),
    set: () => ({ openAtLogin: false }),
  },
  markRendererActivity: () => lease.activity(),
});
