import {
  CONTRACT_VERSION,
  type SystemEvent,
} from "@abacus-ai/contract/contract";
import { FOUNDATION_API } from "@abacus-ai/contract/experience";

import {
  pendingLegacyDrafts,
  acknowledgeLegacyDrafts,
} from "../../services/config/legacy-drafts";
import { conflict, forbidden } from "../errors";
import { impl, onChannel, stream, requireMainRenderer } from "./impl";

export const systemRouter = impl.system.router({
  activity: impl.system.activity.handler(({ context }) => {
    context.deps.app.markRendererActivity();
  }),
  openPrivacyPane: impl.system.openPrivacyPane.handler(({ input, context }) =>
    input.pane === "screen-recording"
      ? context.deps.serviceHost.openScreenRecordingSettings()
      : context.deps.serviceHost.openAccessibilitySettings()
  ),
  dialog: {
    openFolder: impl.system.dialog.openFolder.handler(({ context }) =>
      context.deps.app.openFolderDialog()
    ),
    openFiles: impl.system.dialog.openFiles.handler(({ input, context }) =>
      context.deps.app.openFilesDialog(input?.kind)
    ),
  },
  loginItem: {
    get: impl.system.loginItem.get.handler(({ context }) =>
      context.deps.app.loginItem.get()
    ),
    set: impl.system.loginItem.set.handler(({ input, context }) =>
      context.deps.app.loginItem.set(input.openAtLogin)
    ),
  },
  openExternal: impl.system.openExternal.handler(({ input, context }) =>
    context.deps.app.openExternal(input.url)
  ),
  openPath: impl.system.openPath.handler(({ input, context }) =>
    context.deps.app.openFilePath(input.path)
  ),
  showItemInFolder: impl.system.showItemInFolder.handler(
    ({ input, context }) => {
      context.deps.app.showItemInFolder(input.path);
    }
  ),
  saveCopy: impl.system.saveCopy.handler(({ input, context }) => {
    // The dialog opens on this computer: only its own window may ask.
    if (context.transport !== "message-port")
      throw forbidden("Saving a copy requires the local desktop window.");
    requireMainRenderer(context);
    return context.deps.app.saveCopy(input.items);
  }),
  info: impl.system.info.handler(({ context }) => {
    const { app, host, serviceHost } = context.deps;
    const homeDir = app.homeDir();
    let legacyComposerDrafts: Record<string, string> = {};
    try {
      legacyComposerDrafts = pendingLegacyDrafts(app.botHome());
    } catch (error) {
      console.warn(`[drafts] legacy drafts unreadable: ${String(error)}`);
    }
    return {
      appVersion: app.appVersion(),
      legacyComposerDrafts,
      legacyInstall: app.legacyInstall(),
      platform: process.platform,
      systemLanguages: app.systemLanguages(),
      arch: process.arch,
      versions: { ...process.versions },
      homeDir,
      paths: {
        home: homeDir,
        sessionHome: host.sessionHomePath(),
        botHome: app.botHome(),
      },
      materialIconsBasePath: serviceHost.getMetadata().materialIconsBasePath,
      contractVersion: CONTRACT_VERSION,
      foundationApi: FOUNDATION_API,
    };
  }),
  acknowledgeLegacyDrafts: impl.system.acknowledgeLegacyDrafts.handler(
    ({ input, context }) =>
      acknowledgeLegacyDrafts(context.deps.app.botHome(), input.keys)
  ),
  deleteAllData: impl.system.deleteAllData.handler(({ context }) => {
    if (context.transport !== "message-port")
      throw forbidden("Data reset requires the local desktop window.");
    requireMainRenderer(context);
    context.deps.app.deleteAllData();
  }),
  restart: impl.system.restart.handler(({ context }) => {
    context.deps.app.restartApp();
  }),
  quitGuard: impl.system.quitGuard.handler(
    ({ context }) => context.deps.app.quitGuard?.state() ?? { phase: "idle" }
  ),
  answerQuitGuard: impl.system.answerQuitGuard.handler(({ input, context }) => {
    requireMainRenderer(context);
    context.deps.app.quitGuard?.answer(input.answer);
  }),
  takeOpenLink: impl.system.takeOpenLink.handler(({ context }) => {
    requireMainRenderer(context);
    return context.deps.app.takeOpenLink?.() ?? null;
  }),
  artifactApps: {
    list: impl.system.artifactApps.list.handler(
      ({ context }) => context.deps.app.artifactApps?.list() ?? []
    ),
    status: impl.system.artifactApps.status.handler(
      async ({ input, context }) =>
        (await context.deps.app.artifactApps?.status(input.target)) ?? {
          installable: false,
          installedId: null,
          kind: "site" as const,
        }
    ),
    install: impl.system.artifactApps.install.handler(
      async ({ input, context }) => {
        requireMainRenderer(context);
        const apps = context.deps.app.artifactApps;
        if (!apps) throw forbidden("Installing apps needs the desktop app.");
        return await apps.install(input.target, input.sessionId);
      }
    ),
    uninstall: impl.system.artifactApps.uninstall.handler(
      async ({ input, context }) => {
        requireMainRenderer(context);
        return (
          (await context.deps.app.artifactApps?.uninstall(input.id)) ?? false
        );
      }
    ),
    open: impl.system.artifactApps.open.handler(({ input, context }) => {
      requireMainRenderer(context);
      context.deps.app.artifactApps?.open(input.id);
    }),
  },
  funnelStep: impl.system.funnelStep.handler(({ input, context }) => {
    if (input.once === true)
      context.deps.app.reportFunnelStep(input.step, input.detail, true);
    else context.deps.app.reportFunnelStep(input.step, input.detail);
  }),
  logs: {
    save: impl.system.logs.save.handler(async ({ input, context }) => {
      const result = await context.deps.app.saveLogs(input.rendererLogs);
      if (result.success) return { filePath: result.filePath ?? null };
      // No error means the user cancelled the save dialog.
      if (result.error == null) return { filePath: null };
      throw conflict(result.error);
    }),
    append: impl.system.logs.append.handler(({ input, context }) => {
      context.deps.app.appendLogs(input.lines);
    }),
  },
  notify: impl.system.notify.handler(({ input, context }) => {
    if (input.kind || input.dedupeKey) {
      context.deps.app.showNotification(
        input.title,
        input.body,
        input.metadata,
        {
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        }
      );
    } else
      context.deps.app.showNotification(
        input.title,
        input.body,
        input.metadata
      );
  }),
  events: impl.system.events.handler(({ context, signal }) =>
    stream<SystemEvent>({
      path: "system.events",
      context,
      signal,
      attach: onChannel(context, "system", (event) => event),
      // Each click is its own action.
      coalesceKey: () => null,
    })
  ),
});
