// The account-profile home MUST resolve before any import below reads a path
// under abacusBotHome() — stores open files at module load. Keep this first.
import "./profile-home-init";
import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import fs from "fs/promises";
import os from "os";
import { join } from "path";
import path from "path";
import { promisify } from "util";

import {
  app,
  shell,
  BaseWindow,
  ipcMain,
  screen,
  session,
  nativeImage,
  nativeTheme,
  dialog,
  Notification,
  powerMonitor,
  Menu,
  clipboard,
  crashReporter,
  autoUpdater as nativeAutoUpdater,
} from "electron";
import type { WebContents } from "electron";
import Store from "electron-store";

import type {
  AbacusAccountInfo,
  OpenFilePathResult,
  UsageSnapshot,
} from "#shared/contracts";

/**
 * Where Playwright's default `chrome` channel looks for Google Chrome (stable
 * only, which is what the MCP server launches unless told otherwise).
 */
export function hasGoogleChrome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const candidates =
    platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : platform === "win32"
        ? [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
            .filter((base): base is string => base != null && base.length > 0)
            .map((base) =>
              path.join(base, "Google", "Chrome", "Application", "chrome.exe")
            )
        : [
            "/opt/google/chrome/chrome",
            ...(env.PATH ?? "")
              .split(path.delimiter)
              .filter((dir) => dir.length > 0)
              .flatMap((dir) => [
                path.join(dir, "google-chrome"),
                path.join(dir, "google-chrome-stable"),
              ]),
          ];
  return candidates.some((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}
import { PROVIDER_ENV_VARS } from "#shared/settings";
import type {
  ImportLocalSkillsRequest,
  InstallSkillRequest,
  ListInstalledSkillsRequest,
  OpenSkillFileRequest,
  RemoveSkillRequest,
  SearchMarketplaceSkillsRequest,
} from "#shared/skills-types";
import {
  MACOS_TRAFFIC_LIGHT_POSITION,
  windowChromeMetrics,
} from "#shared/window-chrome";

import { markQuitting, isQuitting } from "./app-quit-state";
import { setBringToFront, setMainWindow } from "./bring-to-front";
import { installCrashGuard } from "./crash-guard";
import { isSafeExternalUrl } from "./external-links";
import { disposeLocalModels, registerIpcHandlers } from "./handler";
import { registerKeepAwakeHandlers } from "./keep-awake";
import { decideLocalOpen } from "./local-open-guard";
import { resolvePastedFilePath } from "./pasted-temp-files";
import { abacusBotHome, userTempDir, WORKSPACE_DIR_NAME } from "./paths";
import { rendererCspHeaders } from "./renderer-csp";
import {
  RendererHost,
  rendererWebContents,
  setActiveRendererHost,
  SwapAborted,
} from "./renderer-host";
import { agentEntry, resourcePath, resourcesRoot } from "./resources";
import { ServiceHost } from "./service-host";
import { registerBrowserRuntimeIpcHandlers } from "./services/browser/browser-runtime-handler";
import { ElectronBrowserRuntime } from "./services/browser/electron-browser-runtime";
import type { BrowserRuntimeWindow } from "./services/browser/electron-browser-runtime";
import { registerRendererState } from "./services/config/renderer-state";
import {
  readNotificationSettings,
  readSettings,
} from "./services/config/settings";
import {
  buildLogDump,
  collectEnvironmentInfo,
  installMainLogCollector,
} from "./services/diagnostics/log-dump";
import { logStore, RETENTION_DAYS } from "./services/diagnostics/log-store";
import { buildZip, type ZipFile } from "./services/diagnostics/zip-write";
import { parsePptx } from "./services/pptx/pptx-parser";
import { fetchAbacusAccount } from "./services/providers/abacus";
import {
  readAccountState,
  forgetAccount,
  signOut,
  skipOnboarding,
} from "./services/providers/account-service";
import { getLocalUsageSnapshot } from "./services/providers/usage";
import { accountStashKey } from "./services/session/account-session-stash";
import { ArtifactResolverService } from "./services/session/artifact-resolver-service";
import {
  initializeExperienceRuntime,
  registerAppScheme,
} from "./services/updates/experience/runtime";
import type { ExperienceRuntime } from "./services/updates/experience/runtime";
import { consumeRelaunchHidden } from "./services/updates/relaunch-hidden";
import { registerUpdateHandlers } from "./services/updates/update-handler";
import { UpdateService } from "./services/updates/update-service";
import { openHostFile } from "./services/workspace/host-path";
import { startSpellcheckDictionaryServer } from "./spellcheck-dictionary";

const APP_DISPLAY_NAME = "AbacusAI Bot";

const isolatedDevelopmentUserData =
  !app.isPackaged && process.env.ABACUSAI_BOT_USERDATA;

// Chromium keeps localStorage, IndexedDB and cookies under userData, so it
// lives inside the account profile too; otherwise renderer and connector state
// would stay app-wide while the filesystem switches accounts.
if (isolatedDevelopmentUserData) {
  app.setPath("userData", isolatedDevelopmentUserData);
} else {
  app.setPath("userData", join(abacusBotHome(), "electron"));
}

/** What CI greps for to know the app started; packaged-startup.test.ts pins it. */
const SMOKE_TEST_READY = "[smoke] main process ready";

// Before anything else: nothing printed before this is recoverable.
logStore().start();
installMainLogCollector((line) => logStore().append("main", line));

// Local-only crash dumps: nothing is uploaded, but a native failure leaves
// more than an opaque exit code.
crashReporter.start({ uploadToServer: false });

/** For the dump; a packaging failure reads as "every message fails to send". */
const resolveArtifactError = (): string | null => {
  try {
    new ArtifactResolverService().resolveBundledCliPath();

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** For the dump. A corrupt session log costs that section, not the file. */
const collectUsageForDump = async (): Promise<{
  usage: UsageSnapshot | null;
  usageError: string | null;
}> => {
  try {
    return { usage: await getLocalUsageSnapshot(), usageError: null };
  } catch (error) {
    return {
      usage: null,
      usageError: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Plan and credits for the dump. Never a throw and never a refresh: a dump is
 * asked for when something is already wrong, and a network round trip is not
 * worth failing it over.
 */
const collectAccountForDump = async (): Promise<AbacusAccountInfo | null> => {
  try {
    return await fetchAbacusAccount();
  } catch {
    return null;
  }
};

// After the collector, so what it catches is recorded. Without it one async
// error puts up Electron's fatal dialog and blocks the main process.
installCrashGuard();

// Opt-in CDP endpoint for driving the app from outside. Development builds
// only: an env var is not a permission, and an open CDP port is full remote
// control of the renderer.
if (!app.isPackaged && process.env.ABACUSAI_BOT_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.ABACUSAI_BOT_DEBUG_PORT
  );
  app.commandLine.appendSwitch("remote-allow-origins", "http://127.0.0.1");
}

// Apps launched from Finder get a minimal PATH without user-installed tools.
// Async, not execSync: shell rc files (nvm, pyenv, oh-my-zsh) can take tens of
// seconds, which would block whenReady. A spawn that races it sees launch PATH.
const execFileAsync = promisify(execFile);
void (async () => {
  if (!app.isPackaged || process.platform === "win32") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const delim = "__PATH_DELIM_a1b2c3__";
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", `echo ${delim}"$PATH"${delim}`],
      {
        encoding: "utf-8",
        timeout: 5000,
      }
    );
    const match = stdout.match(new RegExp(`${delim}(.+?)${delim}`));
    if (match?.[1]) {
      process.env.PATH = match[1];
    }
  } catch {
    /* PATH stays as-is */
  }
})();

type WindowStateSchema = {
  windowWidth: number;
  windowHeight: number;
  windowX: number;
  windowY: number;
};
let store: InstanceType<typeof Store<WindowStateSchema>>;

// Agent work is kept alive across a window close.
function hasBackgroundAgentTask(): boolean {
  return workspaceServiceHost.hasActiveAgentTurn();
}

// Never `getAllWindows()[0]` instead: the messaging connectors hold hidden
// BrowserWindows, and a dock click would reveal WhatsApp Web.
function aliveMainWindow(): BaseWindow | null {
  return mainWindowRef != null && !mainWindowRef.isDestroyed()
    ? mainWindowRef
    : null;
}

// Parented to the app's own window, never a connector's hidden one.
function showOpenDialogFromApp(
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const window = aliveMainWindow();
  return window === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(window, options);
}

function showSaveDialogFromApp(
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const window = aliveMainWindow();
  return window === null
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(window, options);
}

// Reveal the possibly hidden main window (notification clicks, dock activate).
function revealMainWindow(): BaseWindow | null {
  const win = aliveMainWindow();
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  backgroundTaskNotified = false;
  return win;
}

setBringToFront(() => {
  revealMainWindow();
});

// One notification per background stint. Main-process strings stay in
// English: i18n is renderer-only.
let backgroundTaskNotified = false;
function notifyTaskRunningInBackground(): void {
  if (backgroundTaskNotified) return;
  const prefs = readNotificationSettings();
  if (!prefs.enabled) return;
  backgroundTaskNotified = true;
  try {
    const notification = new Notification({
      title: "Task still running",
      body: "We'll notify you when it finishes.",
      silent: !prefs.sound,
    });
    notification.on("click", () => revealMainWindow());
    notification.show();
  } catch {
    // Headless or unsupported environments; non-fatal.
  }
}

const workspaceServiceHost = new ServiceHost();
// A downloaded update restarts only when nothing user-visible is running.
const updateService = new UpdateService({
  isSafeToRestart: () =>
    !workspaceServiceHost.hasActiveAgentTurn() &&
    !workspaceServiceHost.hasLiveTerminalSessions(),
});
let mainWindowRef: BaseWindow | null = null;
let rendererHost: RendererHost | null = null;
/** Null until whenReady; wherever it stays null the packaged baseline runs. */
let experienceRuntime: ExperienceRuntime | null = null;
let rendererSwapTimer: NodeJS.Timeout | null = null;

// Throttled input reports from renderer/lib/activity-beacon; a swap defers
// while input is recent.
const RENDERER_ACTIVITY_HOLD_MS = 15_000;
let lastRendererActivity = 0;
ipcMain.on("renderer-activity", () => {
  lastRendererActivity = Date.now();
});

/**
 * Swap to a newly activated renderer bundle at the first quiet moment. The
 * gates: an agent mid-turn would lose a reply that exists nowhere else yet, a
 * terminal's scrollback lives in the renderer, and recent input defers it.
 */
function scheduleRendererSwap(version: string): void {
  const attempt = (): boolean => {
    // Development stays on the Vite server.
    if (process.env.VITE_DEV_SERVER_URL) return true;

    const url = experienceRuntime?.activeRendererUrl();

    if (!url) return true;

    const host = rendererHost;

    if (host === null) return true;

    if (
      workspaceServiceHost.hasActiveAgentTurn() ||
      workspaceServiceHost.hasLiveTerminalSessions() ||
      Date.now() - lastRendererActivity < RENDERER_ACTIVITY_HOLD_MS
    ) {
      return false;
    }

    host
      .swap(url, {
        shouldAbort: () =>
          workspaceServiceHost.hasActiveAgentTurn() ||
          workspaceServiceHost.hasLiveTerminalSessions() ||
          Date.now() - lastRendererActivity < RENDERER_ACTIVITY_HOLD_MS,
      })
      .then(
        (swapped) => {
          if (swapped) {
            console.log(`[experience] renderer swapped to ${version}`);
          }
        },
        (error: unknown) => {
          if (error instanceof SwapAborted) {
            scheduleRendererSwap(version);

            return;
          }

          console.error("[experience] renderer swap failed", error);
        }
      );

    return true;
  };

  if (rendererSwapTimer !== null) {
    clearInterval(rendererSwapTimer);
    rendererSwapTimer = null;
  }

  if (attempt()) return;

  rendererSwapTimer = setInterval(() => {
    if (attempt() && rendererSwapTimer !== null) {
      clearInterval(rendererSwapTimer);
      rendererSwapTimer = null;
    }
  }, 5000);
  rendererSwapTimer.unref();
}
// webContents resolves through the host so it stays current across swaps.
const browserRuntimeWindow = (): BrowserRuntimeWindow | null => {
  const window = aliveMainWindow();
  const host = rendererHost;

  if (window === null || host === null) return null;

  return {
    contentView: window.contentView,
    getContentBounds: () => window.getContentBounds(),
    isDestroyed: () => window.isDestroyed(),
    get webContents() {
      return host.webContents;
    },
  };
};
const browserRuntime = new ElectronBrowserRuntime(browserRuntimeWindow);
workspaceServiceHost.attachBrowserRuntime(browserRuntime);

async function createWindow() {
  const Store = (await import("electron-store")).default;
  // A corrupt JSON file would otherwise brick the app on every launch.
  store = new Store<WindowStateSchema>({
    name: "window-state",
    clearInvalidConfig: true,
  });

  // Set before a silent update restart of a hidden window, so the relaunch
  // stays hidden instead of popping over the user's work.
  const startHiddenAfterUpdate = consumeRelaunchHidden();

  const { width: screenWidth, height: screenHeight } =
    screen.getPrimaryDisplay().workAreaSize;

  const defaultWidth = 1200;
  const defaultHeight = 900;

  // 90% of the screen when it is smaller than the default.
  const minWidth =
    screenWidth >= defaultWidth ? defaultWidth : Math.floor(screenWidth * 0.9);
  const minHeight =
    screenHeight >= defaultHeight
      ? defaultHeight
      : Math.floor(screenHeight * 0.9);

  const width = store.get("windowWidth", minWidth) as number;
  const height = store.get("windowHeight", minHeight) as number;
  const x = store.get("windowX", undefined) as number | undefined;
  const y = store.get("windowY", undefined) as number | undefined;

  // The icon ships in resources/ beside app.asar, not inside it.
  const iconPath = resourcePath("icon2.png");
  let appIcon = nativeImage.createFromPath(iconPath);

  // Linux window managers often need a 256x256 icon.
  if (process.platform === "linux" && !appIcon.isEmpty()) {
    appIcon = appIcon.resize({ width: 256, height: 256 });
  }

  // setIcon throws on an image that failed to load; the icon is cosmetic.
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  // A relaunch from a dying instance can come back as a UIElement (no Dock
  // icon, no Cmd-Tab entry); asking for the Dock explicitly undoes that.
  if (process.platform === "darwin") {
    app.setActivationPolicy?.("regular");
    void app.dock?.show();
  }

  const titlebar = windowChromeMetrics(process.platform);

  // Matches the renderer so neither flashes through; transparent where
  // vibrancy/mica paint the backdrop.
  const backgroundColor =
    process.platform === "darwin" || process.platform === "win32"
      ? "#00000000"
      : "#2a2a28";

  // The renderer lives in the RendererHost's view, so an update can replace it.
  const mainWindow = new BaseWindow({
    width,
    height,
    x,
    y,
    minWidth: 800,
    minHeight: 600,

    backgroundColor,
    icon: appIcon,
    title: APP_DISPLAY_NAME,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
          ...(nativeTheme.prefersReducedTransparency
            ? {}
            : {
                vibrancy: "under-window" as const,
                visualEffectState: "active" as const,
              }),
        }
      : process.platform === "win32"
        ? {
            // Native controls (with Snap) under the renderer's own top bar.
            titleBarStyle: "hidden" as const,
            titleBarOverlay: {
              color: "#00000000",
              symbolColor: nativeTheme.shouldUseDarkColors
                ? "#fafafa"
                : "#171717",
              height: titlebar.titlebarHeight,
            },
            backgroundMaterial: nativeTheme.prefersReducedTransparency
              ? ("none" as const)
              : ("mica" as const),
          }
        : {
            // Linux window-manager support for custom overlays is inconsistent.
            frame: true,
          }),
  });
  mainWindowRef = mainWindow;
  // Connector login windows hang off this so they share its Space.
  setMainWindow(mainWindow);
  const publishFullScreenState = (): void => {
    if (mainWindow.isDestroyed()) return;
    rendererWebContents()?.send(
      "window:full-screen-changed",
      mainWindow.isFullScreen()
    );
  };
  mainWindow.on("enter-full-screen", publishFullScreenState);
  mainWindow.on("leave-full-screen", publishFullScreenState);
  mainWindow.on("closed", () => {
    if (mainWindowRef !== mainWindow) return;
    mainWindowRef = null;
    setMainWindow(null);
    rendererHost?.dispose();
    rendererHost = null;
    setActiveRendererHost(null);
    try {
      browserRuntime.disposeAll();
    } catch (error) {
      console.warn("[browser-runtime] cleanup failed", error);
    }
  });

  // Spellcheck languages: the OS locale when supported, en-US as fallback.
  // The dictionary download goes through the proxy-aware shim in
  // spellcheck-dictionary.ts, which must be set BEFORE the languages, since
  // setting languages triggers the lazy download.
  void (async () => {
    try {
      const spellSession = session.defaultSession;
      const shimBaseUrl = await startSpellcheckDictionaryServer();
      if (shimBaseUrl)
        spellSession.setSpellCheckerDictionaryDownloadURL(shimBaseUrl);
      const available = spellSession.availableSpellCheckerLanguages;
      const osLocale = app.getLocale(); // e.g. "en-US", "de", "pt-BR"
      const preferred = [osLocale, osLocale.split("-")[0], "en-US"].filter(
        (lang, i, arr) => available.includes(lang) && arr.indexOf(lang) === i
      );
      spellSession.setSpellCheckerLanguages(
        preferred.length ? preferred : ["en-US"]
      );
    } catch (err) {
      console.warn("[spellcheck] failed to configure languages", err);
    }
  })();

  mainWindow.on("resized", () => {
    const [width, height] = mainWindow.getSize();
    store.set("windowWidth", width);
    store.set("windowHeight", height);
  });

  mainWindow.on("moved", () => {
    const [x, y] = mainWindow.getPosition();
    store.set("windowX", x);
    store.set("windowY", y);
  });

  // Closing must not kill in-flight agent work, so the window hides instead.
  // macOS always hides (dock convention); Windows/Linux ask first, and only
  // when a task is running. A real quit sets `isQuitting` first.
  mainWindow.on("close", (event) => {
    if (isQuitting()) return;

    const taskRunning = hasBackgroundAgentTask();

    if (process.platform === "darwin") {
      event.preventDefault();
      if (taskRunning) notifyTaskRunningInBackground();
      // Hiding a full-screen window leaves its Space behind as a black
      // screen; leave full screen first and hide after the transition.
      if (mainWindow.isFullScreen()) {
        mainWindow.once("leave-full-screen", () => {
          if (!mainWindow.isDestroyed()) mainWindow.hide();
        });
        mainWindow.setFullScreen(false);
        return;
      }
      mainWindow.hide();
      return;
    }

    if (!taskRunning) return;

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["Keep running in background", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "A task is running",
      message: "A task is still running.",
      detail: "Keep it running in the background, or quit and stop it?",
    });

    if (choice === 0) {
      event.preventDefault();
      mainWindow.hide();
      notifyTaskRunningInBackground();
    }
  });

  // vite-plugin-electron sets this only while the dev server is running.
  const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? null;

  // Initial load and crash recovery; failures surface via did-fail-load.
  const loadAppContent = (): void => {
    const contents = host.webContents;
    const experienceUrl = experienceRuntime?.activeRendererUrl() ?? null;

    if (rendererUrl) {
      void contents.loadURL(rendererUrl).catch(() => undefined);
    } else if (experienceUrl !== null) {
      // A verified installed experience supersedes the asar baseline.
      console.log(`[experience] serving renderer from ${experienceUrl.href}`);
      void contents.loadURL(experienceUrl.href).catch(() => undefined);
    } else {
      void contents
        .loadFile(join(import.meta.dirname, "../renderer/index.html"))
        .catch(() => undefined);
    }
  };

  // Shown when the renderer fails to load, so the React ErrorBoundary never
  // mounts. A data: URL works with no disk or network; strings stay English.
  const buildErrorPageUrl = (target: string): string => {
    const html = `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#2a2a28;color:#f5f5f4;text-align:center;padding:24px}
  h1{font-size:24px;margin:0 0 8px}
  p{color:#a8a29e;max-width:420px;margin:0 0 24px}
  button{font:inherit;font-weight:600;color:#fff;background:#7c5cff;border:none;
         border-radius:8px;padding:12px 24px;cursor:pointer}
  button:hover{background:#6b4ee6}
</style></head>
<body>
  <h1>Couldn't load the app</h1>
  <p>The application failed to load. Check your connection and try again.</p>
  <button onclick="location.href=${JSON.stringify(target)}">Retry</button>
</body></html>`;
    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
  };
  const errorPageUrl = buildErrorPageUrl(rendererUrl ?? "app://renderer");

  let rendererReloadTimestamps: number[] = [];
  let windowRevealed = false;

  // Runs on the initial view and on each experience swap's replacement.
  const wireRendererContents = (contents: WebContents): void => {
    if (process.argv.includes("--devtools")) {
      contents.openDevTools({ mode: "right" });
    }

    // BaseWindow has no 'ready-to-show'; any view's first load reveals it.
    contents.once("did-finish-load", () => {
      if (windowRevealed || mainWindow.isDestroyed()) return;
      windowRevealed = true;
      // A saved position may be off-screen after a monitor change.
      const displays = screen.getAllDisplays();
      const bounds = mainWindow.getBounds();
      const isVisible = displays.some((d) => {
        const wb = d.workArea;
        return (
          bounds.x + bounds.width > wb.x &&
          bounds.x < wb.x + wb.width &&
          bounds.y + bounds.height > wb.y &&
          bounds.y < wb.y + wb.height
        );
      });
      if (!isVisible) {
        mainWindow.center();
      }
      // A silent update restart of a hidden window comes back hidden.
      if (!startHiddenAfterUpdate) mainWindow.show();
    });

    // Spelling suggestions plus the standard editing actions.
    contents.on("context-menu", (_event, params) => {
      const {
        editFlags,
        misspelledWord,
        dictionarySuggestions,
        isEditable,
        selectionText,
      } = params;
      const template: Electron.MenuItemConstructorOptions[] = [];

      if (misspelledWord) {
        if (dictionarySuggestions.length) {
          for (const suggestion of dictionarySuggestions) {
            template.push({
              label: suggestion,
              click: () => contents.replaceMisspelling(suggestion),
            });
          }
        } else {
          template.push({ label: "No spelling suggestions", enabled: false });
        }
        template.push({
          label: "Add to dictionary",
          click: () =>
            contents.session.addWordToSpellCheckerDictionary(misspelledWord),
        });
        template.push({ type: "separator" });
      }

      if (isEditable || selectionText) {
        template.push(
          { role: "cut", enabled: isEditable && editFlags.canCut },
          { role: "copy", enabled: editFlags.canCopy },
          { role: "paste", enabled: isEditable && editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", enabled: editFlags.canSelectAll }
        );
      }

      if (template.length) {
        Menu.buildFromTemplate(template).popup({ window: mainWindow });
      }
    });

    contents.setWindowOpenHandler((details) => {
      // Same scheme check as an explicit "open externally" click.
      if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url);
      else console.warn("[Shell] Refused to open a window for", details.url);
      return { action: "deny" };
    });

    // A <webview>'s privileges come from its attributes (`preload` runs with
    // full Node, `nodeintegration` hands the guest `require`), and the panes
    // render agent-written HTML. Stripped here no matter what the tag asked.
    contents.on("will-attach-webview", (_event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      // Electron reads the attributes back, so they go too.
      delete params.preload;
      delete params.nodeintegration;
      delete params.nodeintegrationinsubframes;
    });

    // A reload of the live renderer must dispose its browser views first, or
    // crash recovery leaks hidden Chromium pages with no owner. Only the live
    // view: a swap candidate's load must not touch the running panes.
    contents.on(
      "did-start-navigation",
      (_event, _url, isSameDocument, isMainFrame) => {
        if (contents !== rendererWebContents()) return;
        if (isMainFrame && !isSameDocument) browserRuntime.disposeAll();
      }
    );

    // Renderer failure recovery acts only on the live view; a swap candidate's
    // failure is the swap's own error. Auto-reload up to 2x per rolling 60s,
    // then ask the user.
    contents.on("render-process-gone", (_event, details) => {
      if (contents !== rendererWebContents()) return;
      console.error(
        `[recovery] render-process-gone: ${details.reason} (exit ${details.exitCode ?? "?"})`
      );
      // 'clean-exit' is a reload we asked for, not a crash.
      if (details.reason === "clean-exit") return;

      const now = Date.now();
      rendererReloadTimestamps = rendererReloadTimestamps.filter(
        (t) => now - t < 60_000
      );
      if (rendererReloadTimestamps.length < 2) {
        rendererReloadTimestamps.push(now);
        console.warn(
          `[recovery] renderer gone (${details.reason}) — auto-reloading`
        );
        loadAppContent();
        return;
      }

      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "error",
        buttons: ["Restart", "Quit"],
        defaultId: 0,
        cancelId: 1,
        title: APP_DISPLAY_NAME,
        message: "The app keeps crashing",
        detail:
          "The application window has crashed repeatedly. Restart to try again.",
      });
      // `quit`, not `exit`: before-quit tears the terminal PTYs down first.
      if (choice === 0) app.relaunch();
      app.quit();
    });

    contents.on("unresponsive", () => {
      if (contents !== rendererWebContents()) return;
      console.error("[recovery] renderer unresponsive");
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["Wait", "Reload"],
        defaultId: 0,
        cancelId: 0,
        title: APP_DISPLAY_NAME,
        message: "The app is not responding",
        detail: "You can keep waiting, or reload the window to recover.",
      });
      if (choice === 1) {
        loadAppContent();
      }
    });

    // The entry point failed: show the window (first paint never comes) with
    // the local error page.
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (contents !== rendererWebContents()) return;
        // -3 is ERR_ABORTED (our own navigations); also skip sub-frames and
        // the error page reloading itself.
        if (!isMainFrame || errorCode === -3) return;
        if (validatedURL && validatedURL.startsWith("data:text/html")) return;
        console.warn(
          `[recovery] did-fail-load (${errorCode} ${errorDescription}) — showing error page`
        );
        if (!mainWindow.isDestroyed()) {
          mainWindow.show();
          void contents.loadURL(errorPageUrl).catch(() => undefined);
        }
      }
    );
  };

  const host = new RendererHost({
    backgroundColor,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: false,
      backgroundThrottling: false,
      webviewTag: true,
      spellcheck: true,
    },
    window: mainWindow,
    wire: wireRendererContents,
  });
  rendererHost = host;
  setActiveRendererHost(host);

  loadAppContent();
}

// Before `whenReady`, or a dev run shows "Electron" in the menu bar. Keep the
// hyphen: Chromium names its keychain entry (and so the cookie encryption key)
// after this, and on Linux it is the WM_CLASS. Menus and titles use
// APP_DISPLAY_NAME instead.
app.setName("AbacusAI-Bot");

// Privileged schemes must be registered before `whenReady`.
registerAppScheme();

// Two instances would write the same electron-store files and silently lose
// sessions. Losing the lock is not final: a relaunch's child arrives while
// its parent is still dying, so whenReady retries before giving up.
let gotSingleInstanceLock = app.requestSingleInstanceLock();
if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    revealMainWindow();
  });
}

app
  .whenReady()
  .then(async () => {
    if (!gotSingleInstanceLock) {
      // Thirty seconds: a dying parent's shutdown (agent children, connectors)
      // routinely outlives five, and giving up first leaves the user with no
      // app. A genuinely running primary keeps the lock and this process quits.
      for (let attempt = 0; attempt < 60 && !gotSingleInstanceLock; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        gotSingleInstanceLock = app.requestSingleInstanceLock();
      }
      if (!gotSingleInstanceLock) {
        app.quit();
        return;
      }
      app.on("second-instance", () => {
        revealMainWindow();
      });
    }

    app.setAppUserModelId("ai.abacus.bot");

    // Serve the renderer CSP as a response header too (see renderer-csp.ts).
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: rendererCspHeaders(details) });
    });

    // F12 toggles DevTools while developing.
    app.on("browser-window-created", (_, window) => {
      window.webContents.on("before-input-event", (_event, input) => {
        if (
          input.type === "keyDown" &&
          input.key === "F12" &&
          !app.isPackaged
        ) {
          window.webContents.toggleDevTools();
        }
      });
    });

    registerUpdateHandlers(updateService);
    workspaceServiceHost.initialize();
    // A profile relaunch lands here already signed in, so the sign-in handler
    // that normally restores the stash never ran.
    void fetchAbacusAccount().then((account) => {
      if (account != null)
        workspaceServiceHost.restoreSessionsForAccount(
          accountStashKey(
            account.email,
            readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? null
          )
        );
    });
    workspaceServiceHost.start();
    registerRendererState();
    registerIpcHandlers(workspaceServiceHost);
    registerBrowserRuntimeIpcHandlers(
      browserRuntime,
      () => rendererWebContents()?.id ?? null
    );
    workspaceServiceHost.startCronScheduler();
    // A minute in, so the gateway and sign-in state have settled first.
    setTimeout(() => {
      void workspaceServiceHost
        .learnPersonaIfGmailConnected()
        .catch(() => undefined);
    }, 60_000).unref();

    // Reap devices a previous run booted but never shut down (force quit and
    // crashes skip `before-quit`). Only ever touches devices we started.
    void workspaceServiceHost
      .shutdownDevicesBootedByUs()
      .catch(() => undefined);

    registerKeepAwakeHandlers();

    // Best-effort cleanup of attachment temp files older than 7 days across
    // every workspace; never blocks startup.
    void (async () => {
      try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const workspaces = workspaceServiceHost.getMetadata().workspaces ?? [];
        await Promise.all(
          workspaces.map(async (ws) => {
            const wsPath = (ws as { path?: string }).path;
            if (typeof wsPath !== "string" || wsPath.length === 0) return;
            const tempDir = path.join(wsPath, WORKSPACE_DIR_NAME, "temp");
            if (!existsSync(tempDir)) return;
            try {
              const entries = await fs.readdir(tempDir, {
                withFileTypes: true,
              });
              await Promise.all(
                entries.map(async (entry) => {
                  if (entry.name === ".gitignore") return;
                  const full = path.join(tempDir, entry.name);
                  try {
                    const stat = await fs.stat(full);
                    if (stat.mtimeMs < cutoff) {
                      await fs.rm(full, { recursive: true, force: true });
                    }
                  } catch {
                    /* ignore per-entry failures */
                  }
                })
              );
            } catch {
              /* directory unreadable — skip this workspace */
            }
          })
        );
      } catch {
        /* ignore overall failures — cleanup is non-essential */
      }
    })();
    ipcMain.handle("open-external", async (_event, url: string) => {
      if (!isSafeExternalUrl(url)) {
        // Refused rather than thrown: the callers are click handlers that do
        // not await.
        console.warn("[Shell] Refused to open", url);
        return;
      }
      await shell.openExternal(url);
    });

    // Restricted to directories the app works in: the paths include file
    // links out of model-generated markdown.
    ipcMain.handle(
      "open-file-path",
      async (_event, filePath: string): Promise<OpenFilePathResult> => {
        const roots = [
          ...workspaceServiceHost
            .getMetadata()
            .workspaces.filter((w) => w.isRemote !== true && w.path != null)
            .map((w) => w.path as string),
          abacusBotHome(),
          // Shared on Linux; the guard admits only files this user owns.
          userTempDir(),
        ];
        const decision = decideLocalOpen(filePath, roots);
        if (decision.action === "refuse") {
          console.warn("[Shell] Refused to open path", filePath);
          return { outcome: "refused", reason: decision.reason };
        }
        // The resolved path, which the checks ran against; a symlink can be
        // re-pointed between check and open.
        if (decision.action === "reveal") {
          shell.showItemInFolder(decision.path);
          return { outcome: "revealed" };
        }
        await shell.openPath(decision.path);
        return { outcome: "opened" };
      }
    );

    ipcMain.handle("show-item-in-folder", (_event, filePath: string) => {
      shell.showItemInFolder(filePath);
    });

    app.setAboutPanelOptions({
      applicationName: APP_DISPLAY_NAME,
      applicationVersion: app.getVersion(),
      copyright: `Copyright © ${new Date().getFullYear()} Abacus.AI`,
      credits: "Open source under the MIT License",
      website: "https://github.com/abacusai/abacusai-bot/blob/main/README.md",
      iconPath: resourcePath("icon2.png"),
    });
    if (process.platform === "darwin") {
      // The default menu labels its items from app.name, which keeps the hyphen.
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              { role: "about", label: `About ${APP_DISPLAY_NAME}` },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: `Hide ${APP_DISPLAY_NAME}` },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: `Quit ${APP_DISPLAY_NAME}` },
            ],
          },
          { role: "fileMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ])
      );
    }
    ipcMain.handle("get-app-version", () => app.getVersion());
    ipcMain.handle("window:show-about", () => app.showAboutPanel());
    ipcMain.handle(
      "window:is-full-screen",
      () => mainWindowRef?.isFullScreen() ?? false
    );

    // Relaunch after adding skills so new agent processes load them at startup.
    ipcMain.handle("restart-app", () => {
      app.relaunch();
      app.quit();
    });

    ipcMain.handle("get-home-dir", () => {
      return os.homedir();
    });

    ipcMain.handle("has-google-chrome", () => hasGoogleChrome());

    ipcMain.handle(
      "theme:set",
      (_event, source: "system" | "light" | "dark") => {
        if (source !== "system" && source !== "light" && source !== "dark") {
          throw new Error("Invalid theme source");
        }
        nativeTheme.themeSource = source;

        const window = mainWindowRef;
        if (window != null && !window.isDestroyed()) {
          if (process.platform === "win32") {
            window.setTitleBarOverlay({
              color: "#00000000",
              symbolColor: nativeTheme.shouldUseDarkColors
                ? "#fafafa"
                : "#171717",
              height: windowChromeMetrics("win32").titlebarHeight,
            });
            window.setBackgroundMaterial(
              nativeTheme.prefersReducedTransparency ? "none" : "mica"
            );
          } else if (process.platform === "darwin") {
            window.setVibrancy(
              nativeTheme.prefersReducedTransparency ? null : "under-window"
            );
          }
        }

        return nativeTheme.shouldUseDarkColors;
      }
    );

    // `on`, not `handle`: the renderer must never wait on main to log a line.
    ipcMain.on("append-logs", (_event, lines: unknown) => {
      if (!Array.isArray(lines)) return;

      for (const line of lines) {
        if (typeof line === "string") logStore().append("renderer", line);
      }
    });

    // A summary of this run plus every retained day of logs: the run someone
    // reports is rarely the one still going.
    ipcMain.handle("save-logs", async (_event, rendererLogs: string) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const result = await showSaveDialogFromApp({
        title: "Save logs",
        defaultPath: path.join(
          app.getPath("downloads"),
          `abacusai-bot-logs-${stamp}.zip`
        ),
        filters: [{ name: "Zip Archives", extensions: ["zip"] }],
      });
      if (result.canceled || !result.filePath) return { success: false };

      try {
        const summary = buildLogDump({
          appVersion: app.getVersion(),
          isPackaged: app.isPackaged,
          homeDir: abacusBotHome(),
          rendererLogs: typeof rendererLogs === "string" ? rendererLogs : "",
          sessions: workspaceServiceHost.collectAgentDiagnostics(),
          environment: collectEnvironmentInfo({
            resourcesPath: resourcesRoot(),
            agentEntry: agentEntry(),
            artifactError: resolveArtifactError(),
          }),
          retainedDays: RETENTION_DAYS,
          account: await collectAccountForDump(),
          ...(await collectUsageForDump()),
        });

        const files: ZipFile[] = [
          { name: "summary.txt", content: Buffer.from(summary, "utf-8") },
        ];

        // `files()` flushes first, so the lines written a moment ago are in.
        for (const file of logStore().files()) {
          try {
            files.push({
              name: `logs/${file.name}`,
              content: await fs.readFile(file.path),
            });
          } catch {
            // A file that vanished mid-dump costs its day, not the bundle.
          }
        }

        await fs.writeFile(result.filePath, buildZip(files));
        return { success: true, filePath: result.filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // The local account; see shared/account.ts for why it is optional.
    ipcMain.handle("account:get", () => readAccountState());
    ipcMain.handle("account:skip", () => skipOnboarding());
    ipcMain.handle("account:sign-out", () => signOut());
    ipcMain.handle("account:forget", () => forgetAccount());

    ipcMain.handle("open-folder-dialog", async () => {
      const result = await showOpenDialogFromApp({
        properties: ["openDirectory", "dontAddToRecent", "createDirectory"],
        title: "Select Folder",
      });
      return result?.filePaths?.[0] || null;
    });

    // Agent-produced image as a data URL. Real paths on both sides, anything
    // escaping the root refused, extension allow-list, size cap.
    {
      const IMAGE_MIME: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".ico": "image/x-icon",
        ".svg": "image/svg+xml",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
      };
      const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

      ipcMain.handle(
        "files:read-image-as-data-url",
        async (_event, args: { filePath?: string; hostRoot?: string }) => {
          try {
            const filePath = args?.filePath;
            const hostRoot = args?.hostRoot;
            if (!filePath || !hostRoot) {
              return {
                success: false,
                error: "filePath and hostRoot are required",
              };
            }

            const ext = path.extname(filePath).toLowerCase();
            const mimeType = IMAGE_MIME[ext];
            if (!mimeType) {
              return { success: false, error: "unsupported-extension" };
            }

            const file = await openHostFile(filePath, hostRoot);
            if (file.ok === false) return { success: false, error: file.error };
            const { realFile, stat } = file;
            if (stat.size > MAX_IMAGE_BYTES) {
              return {
                success: false,
                error: "too-large",
                sizeBytes: stat.size,
              };
            }

            const buf = await fs.readFile(realFile);
            const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
            return { success: true, dataUrl, mimeType, sizeBytes: stat.size };
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
    }

    // Same path resolution and sandboxing as the image reader above.
    {
      const MAX_TEXT_BYTES_DEFAULT = 524288; // 512 KB

      ipcMain.handle(
        "files:read-file-as-text",
        async (
          _event,
          args: { filePath?: string; hostRoot?: string; maxBytes?: number }
        ) => {
          try {
            const filePath = args?.filePath;
            const hostRoot = args?.hostRoot;
            if (!filePath || !hostRoot) {
              return {
                success: false,
                error: "filePath and hostRoot are required",
              };
            }

            const maxBytes = args?.maxBytes ?? MAX_TEXT_BYTES_DEFAULT;

            const file = await openHostFile(filePath, hostRoot);
            if (file.ok === false) return { success: false, error: file.error };
            const { realFile, stat } = file;

            const sizeBytes = stat.size;

            // A null byte in the first 8KB marks a binary file.
            const fd = await fs.open(realFile, "r");
            try {
              const probe = Buffer.alloc(Math.min(8192, sizeBytes));
              await fd.read(probe, 0, probe.length, 0);
              if (probe.includes(0)) {
                return { success: false, error: "binary-file", sizeBytes };
              }
            } finally {
              await fd.close();
            }

            const truncated = sizeBytes > maxBytes;
            let content: string;
            if (truncated) {
              const buf = Buffer.alloc(maxBytes);
              const fd2 = await fs.open(realFile, "r");
              try {
                await fd2.read(buf, 0, maxBytes, 0);
              } finally {
                await fd2.close();
              }
              content = buf.toString("utf8");
            } else {
              content = await fs.readFile(realFile, "utf8");
            }

            return { success: true, content, sizeBytes, truncated };
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
    }

    // Parsed here, not in the renderer: sending back slides is cheaper than
    // shipping a 40 MB deck across IPC. Same sandboxing as the readers above.
    {
      // Embedded images come back as base64 data URLs, so the payload lands
      // several times larger than the file; 200 MB wedged the renderer.
      const MAX_PPTX_BYTES = 60 * 1024 * 1024; // 60 MB

      ipcMain.handle(
        "files:read-pptx",
        async (_event, args: { filePath?: string; hostRoot?: string }) => {
          try {
            const filePath = args?.filePath;
            const hostRoot = args?.hostRoot;
            if (!filePath || !hostRoot) {
              return {
                success: false,
                error: "filePath and hostRoot are required",
              };
            }

            const file = await openHostFile(filePath, hostRoot);
            if (file.ok === false) return { success: false, error: file.error };
            const { realFile, stat } = file;
            if (stat.size > MAX_PPTX_BYTES) {
              return {
                success: false,
                error: "too-large",
                sizeBytes: stat.size,
              };
            }

            const buf = await fs.readFile(realFile);
            const deck = parsePptx(buf);
            return { success: true, deck, sizeBytes: stat.size };
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
    }

    // `kind: 'image'` narrows the picker for the composer's "Images" item.
    ipcMain.handle(
      "open-files-dialog",
      async (_event, kind?: "all" | "image") => {
        const imagesOnly = kind === "image";
        const result = await showOpenDialogFromApp({
          properties: ["openFile", "multiSelections"],
          title: imagesOnly ? "Select Images" : "Select Files",
          ...(imagesOnly
            ? {
                filters: [
                  {
                    name: "Images",
                    extensions: [
                      "png",
                      "jpg",
                      "jpeg",
                      "gif",
                      "webp",
                      "bmp",
                      "svg",
                      "ico",
                      "heic",
                      "tiff",
                    ],
                  },
                ],
              }
            : {}),
        });

        if (result.canceled || !result.filePaths?.length) return null;

        const MIME_MAP: Record<string, string> = {
          ".pdf": "application/pdf",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".bmp": "image/bmp",
          ".ico": "image/x-icon",
          ".heic": "image/heic",
          ".tif": "image/tiff",
          ".tiff": "image/tiff",
          ".json": "application/json",
          ".xml": "application/xml",
          ".csv": "text/csv",
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".ts": "text/typescript",
          ".jsx": "text/javascript",
          ".tsx": "text/typescript",
          ".py": "text/x-python",
          ".yaml": "text/yaml",
          ".yml": "text/yaml",
          ".log": "text/plain",
          ".sh": "text/x-shellscript",
          ".bat": "text/x-bat",
          ".toml": "text/plain",
          ".ini": "text/plain",
          ".cfg": "text/plain",
          ".env": "text/plain",
          ".doc": "application/msword",
          ".docx":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".xls": "application/vnd.ms-excel",
          ".xlsx":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ".ppt": "application/vnd.ms-powerpoint",
          ".pptx":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ".zip": "application/zip",
          ".gz": "application/gzip",
          ".tar": "application/x-tar",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".mp4": "video/mp4",
          ".mov": "video/quicktime",
        };

        const files = await Promise.all(
          result.filePaths.map(async (filePath) => {
            const data = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeType = MIME_MAP[ext] || "application/octet-stream";
            return {
              path: filePath,
              name: path.basename(filePath),
              data,
              mimeType,
            };
          })
        );

        return files;
      }
    );

    // Backs the "Paste image" attach item, which has no paste event to read
    // because the click happens in a menu. Null when there is no image.
    ipcMain.handle("read-clipboard-image", () => {
      try {
        const image = clipboard.readImage();
        if (image == null || image.isEmpty()) return null;
        const data = image.toPNG();
        if (data.length === 0) return null;
        return {
          name: `clipboard-${Date.now()}.png`,
          data,
          mimeType: "image/png",
        };
      } catch {
        return null;
      }
    });

    // A user-directed fetch of a user-typed address for staging as an
    // attachment. http/https only, and capped so an endless body cannot wedge
    // the app.
    ipcMain.handle("fetch-url-attachment", async (_event, rawUrl: string) => {
      const MAX_BYTES = 25 * 1024 * 1024;
      let url: URL;
      try {
        url = new URL(String(rawUrl ?? "").trim());
      } catch {
        return { success: false, error: "That is not a valid URL." };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          success: false,
          error: "Only http:// and https:// URLs can be attached.",
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) {
          return {
            success: false,
            error: `Request failed (${response.status} ${response.statusText}).`,
          };
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          return { success: false, error: "That file is larger than 25 MB." };
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_BYTES) {
          return { success: false, error: "That file is larger than 25 MB." };
        }

        const mimeType = (
          response.headers.get("content-type") ?? "application/octet-stream"
        )
          .split(";")[0]
          .trim();
        // Falls back to the host so a URL ending in "/" is still recognisable.
        const base = path.basename(url.pathname).trim();
        const hasExt = base.includes(".") && !base.endsWith(".");
        const extFromMime =
          mimeType === "text/html"
            ? ".html"
            : mimeType === "application/pdf"
              ? ".pdf"
              : mimeType.startsWith("image/")
                ? `.${mimeType.slice("image/".length)}`
                : mimeType.startsWith("text/")
                  ? ".txt"
                  : "";
        const name =
          base.length > 0 && hasExt
            ? base
            : `${(base.length > 0 ? base : url.hostname).replace(/[^\w.-]+/g, "-")}${extFromMime}`;

        return { success: true, file: { name, data: buffer, mimeType } };
      } catch (err) {
        const aborted =
          (err as { name?: string } | null)?.name === "AbortError";
        return {
          success: false,
          error: aborted
            ? "The request timed out."
            : `Could not fetch that URL: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    });

    ipcMain.handle(
      "show-notification",
      (
        _event,
        title: string,
        body: string,
        metadata?: { tab?: string; workspaceId?: string; sessionId?: string }
      ) => {
        // Gated here, the one place every notification passes through.
        const prefs = readNotificationSettings();
        if (!prefs.enabled) return;
        const notification = new Notification({
          title,
          body,
          silent: !prefs.sound,
        });
        notification.on("click", () => {
          const win = revealMainWindow();
          // Consumed by the onNotificationClicked subscriber in app.tsx.
          if (win && metadata) {
            rendererWebContents()?.send("notification-clicked", metadata);
          }
        });
        notification.show();
      }
    );

    // Pasted/dropped attachments go under <baseFolder>/.abacusai-bot/temp/.
    ipcMain.handle(
      "save-pasted-temp-files",
      async (
        _event,
        baseFolder: string,
        files: Array<{ name: string; data: Uint8Array }>
      ) => {
        try {
          if (typeof baseFolder !== "string" || baseFolder.length === 0) {
            return { success: false, error: "workspace path required" };
          }
          const tempDir = path.join(baseFolder, WORKSPACE_DIR_NAME, "temp");
          mkdirSync(tempDir, { recursive: true });
          // Self-ignoring: the user's repo does not ignore .abacusai-bot/, and
          // untracked attachments would read as "the agent created these".
          await fs
            .writeFile(path.join(tempDir, ".gitignore"), "*\n")
            .catch(() => {});
          // Renderer-supplied names; resolvePastedFilePath keeps writes inside.
          const paths = files.map((file) =>
            resolvePastedFilePath(tempDir, file.name)
          );
          await Promise.all(
            files.map((file, i) =>
              fs.writeFile(paths[i], Buffer.from(file.data))
            )
          );
          return { success: true, dir: tempDir, paths };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }
    );

    // Skills management and marketplace (api.skills.*).
    ipcMain.handle(
      "skills-list-installed",
      (_event, request: ListInstalledSkillsRequest) => {
        return workspaceServiceHost.skillsService.listInstalled(request ?? {});
      }
    );
    ipcMain.handle(
      "skills-search-marketplace",
      (_event, request: SearchMarketplaceSkillsRequest) => {
        return workspaceServiceHost.skillsService.searchMarketplace(request);
      }
    );
    ipcMain.handle("skills-install", (_event, request: InstallSkillRequest) => {
      return workspaceServiceHost.skillsService.install(request);
    });
    ipcMain.handle("skills-remove", (_event, request: RemoveSkillRequest) => {
      return workspaceServiceHost.skillsService.remove(request);
    });
    ipcMain.handle(
      "skills-open-file",
      (_event, request: OpenSkillFileRequest) => {
        return workspaceServiceHost.skillsService.openFile(request);
      }
    );
    // The picker lives here (needs the focused window); the service validates
    // and copies. Always global scope.
    ipcMain.handle(
      "skills-import-local",
      async (_event, request: ImportLocalSkillsRequest) => {
        const kind = request?.kind === "folder" ? "folder" : "file";
        const result = await showOpenDialogFromApp({
          title:
            kind === "folder"
              ? "Select skill folder(s)"
              : "Select skill file(s)",
          properties:
            kind === "folder"
              ? ["openDirectory", "multiSelections", "dontAddToRecent"]
              : ["openFile", "multiSelections", "dontAddToRecent"],
          ...(kind === "file"
            ? { filters: [{ name: "Skill", extensions: ["md"] }] }
            : {}),
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, cancelled: true };
        }
        return workspaceServiceHost.skillsService.importFromPaths({
          paths: result.filePaths,
          kind,
        });
      }
    );

    // Global skills layout at startup, even if the Skills dialog never opens.
    try {
      workspaceServiceHost.skillsService.ensureGlobalSkillsLayout();
    } catch {
      /* retried lazily on the first global list/install */
    }
  })
  .then(async () => {
    // Before the first window, so a verified installed experience is served
    // on this launch. On failure the app runs its baseline.
    try {
      experienceRuntime = await initializeExperienceRuntime({
        onRendererChanged: (version) => {
          scheduleRendererSwap(version);
        },
      });
    } catch (error) {
      console.error("[experience] runtime failed to initialize", error);
    }
  })
  .then(createWindow)
  .then(() => {
    updateService.checkForUpdatesOnStartup();

    app.on("activate", function () {
      // Keyed on the main window, not getAllWindows(): the connectors' hidden
      // windows keep that array non-empty when the app's own window is gone.
      if (aliveMainWindow() == null) {
        createWindow();
      } else {
        revealMainWindow();
      }
    });

    powerMonitor.on("lock-screen", () => {});
    powerMonitor.on("unlock-screen", () => {});

    // CI's proof that the app starts, printed once every module has evaluated
    // and the window exists. A live pid is not proof: an import-time exception
    // puts up Electron's error dialog and waits on it.
    if (process.env.ABACUSAI_BOT_SMOKE_TEST === "1") {
      console.log(SMOKE_TEST_READY);
      // exit, not quit: the shutdown path can hold a probe process open.
      app.exit(0);
    }
  });

// On macOS the app stays in the dock.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Squirrel.Mac's quitAndInstall closes all windows before app.quit(), so
// before-quit has not fired and the darwin 'close' handler would hide the
// window, leaving the install spinning forever. Mark the quit before the
// closes. A second seam beside UpdateService.installUpdate().
nativeAutoUpdater.on("before-quit-for-update", () => {
  markQuitting();
});

let quitGracefulInProgress = false;
app.on("before-quit", (event) => {
  // So the window 'close' handler stops intercepting.
  markQuitting();
  logStore().flush();
  try {
    browserRuntime.disposeAll();
  } catch (error) {
    console.warn("[browser-runtime] cleanup failed", error);
  }
  if (quitGracefulInProgress) return;
  quitGracefulInProgress = true;

  try {
    experienceRuntime?.dispose();
  } catch (error) {
    console.warn("[experience] cleanup failed", error);
  }
  // The loaded model is gigabytes of memory; the server does not outlive the app.
  disposeLocalModels();

  // Quit must wait for this (bounded below): the SIGKILL escalation runs on
  // an unref'd timer, and returning synchronously would let a wedged agent
  // survive quit.
  const agentsStopped = workspaceServiceHost.dispose();

  // Only devices we booted, never ones the user started.
  const needDeviceShutdown = workspaceServiceHost.hasDevicesBootedByUs();

  event.preventDefault();
  (async (): Promise<void> => {
    // Cleanup must never hang the quit.
    const cap = new Promise<void>((resolve) => setTimeout(resolve, 6_000));
    try {
      await Promise.race([
        cap,
        Promise.all([
          agentsStopped,
          needDeviceShutdown
            ? workspaceServiceHost.shutdownDevicesBootedByUs()
            : Promise.resolve(),
        ]),
      ]);
    } catch (err) {
      console.warn("[quit] graceful shutdown failed:", err);
    } finally {
      app.exit(0);
    }
  })();
});
