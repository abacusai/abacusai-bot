import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isFunnelStep, funnelDetail } from "@abacus-ai/contract/funnel";

import {
  nodeFileOperations,
  saveLogArchive,
  importPickedSkills,
} from "#main/app-operations/node";
import { abacusBotHome } from "#main/paths";
import type { AppOperations } from "#main/rpc/deps";
import { emitBusChannel } from "#main/rpc/emit";
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

import { app } from "./electron-shim";
import type { HostLease } from "./lease";
import { unsupported } from "./unsupported";
export const createNodeAppOperations = (
  lease: HostLease,
  serviceHost: import("#main/service-host").ServiceHost
): AppOperations => ({
  ...nodeFileOperations,
  openFolderDialog: async () => null,
  openFilesDialog: async () => null,
  openExternal: async () => unsupported("system.openExternal"),
  openFilePath: async () => ({ outcome: "refused", reason: "outside" }),
  showItemInFolder: () => {},
  appVersion: app.getVersion,
  homeDir: homedir,
  botHome: abacusBotHome,
  restartApp: () => process.exit(75),
  hasGoogleChrome: () => false,
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
  saveLogs: async (logs) => {
    try {
      const dir = join(abacusBotHome(), "host", "log");
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `logs-${Date.now()}.zip`);
      return saveLogArchive(filePath, logs, {
        appVersion: app.getVersion(),
        isPackaged: false,
        sessions: serviceHost.collectAgentDiagnostics(),
      });
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
  showNotification: (title, body, metadata) =>
    emitBusChannel("system", { type: "notification", title, body, metadata }),
  importLocalSkills: (request) =>
    importPickedSkills(serviceHost.skillsService, [], request.kind),
  showAboutPanel: () => unsupported("system.about"),
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
