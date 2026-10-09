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
  info: impl.system.info.handler(({ context }) => {
    const { app, host, serviceHost } = context.deps;
    const homeDir = app.homeDir();
    return {
      appVersion: app.appVersion(),
      legacyComposerDrafts: pendingLegacyDrafts(app.botHome()),
      platform: process.platform,
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
