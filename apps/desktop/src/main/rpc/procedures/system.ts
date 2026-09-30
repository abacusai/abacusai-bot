import { CONTRACT_VERSION, type SystemEvent } from "#shared/contract";
import { FOUNDATION_API } from "#shared/experience";

import { conflict } from "../errors";
import { impl, onChannel, stream } from "./impl";

export const systemRouter = impl.system.router({
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
    context.deps.app.showNotification(input.title, input.body, input.metadata);
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
