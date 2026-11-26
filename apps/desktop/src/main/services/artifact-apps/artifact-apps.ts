/**
 * "Install as app" (spike): an artifact page opened from the OS launcher in a
 * window of its own. Installing writes a launcher entry that starts this app
 * with `abacusaibot://app?id=<id>`; the window shows the artifact's own
 * index.html (its CSP: no network), reloads when the agent edits it, and keeps
 * what the user enters in a small store of its own (`window.abacus.store`).
 *
 * Registry and data live under `<userData>/artifact-apps/`:
 *   registry.json            { [id]: { id, path, title, installedAt } }
 *   <id>/icon.png, icon.ico  the launcher icon
 *   <id>/store.json          the app's saved data
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isArtifactPage } from "@abacus-ai/contract/share";
import {
  app,
  BaseWindow,
  session,
  shell,
  WebContentsView,
  type WebContents,
} from "electron";

import { appIconPng, pngToIco } from "./icon";

export interface InstalledApp {
  id: string;
  /** The artifact's index.html. */
  path: string;
  title: string;
  installedAt: string;
}

const APP_LINK = /^abacusaibot:\/\/app\/?\?id=([a-f0-9]{16})$/i;

/** The app id a launcher link asks for, or null when it is not one. */
export const artifactAppLinkId = (raw: string | null): string | null =>
  raw == null ? null : (APP_LINK.exec(raw.trim())?.[1]?.toLowerCase() ?? null);

export const artifactAppLinkInArgv = (argv: readonly string[]): string | null =>
  argv.map(artifactAppLinkId).find((id) => id != null) ?? null;

const root = (): string => join(app.getPath("userData"), "artifact-apps");
const registryFile = (): string => join(root(), "registry.json");
const appDir = (id: string): string => join(root(), id);

const appIdFor = (path: string): string =>
  createHash("sha256").update(path).digest("hex").slice(0, 16);

const writeAtomic = (file: string, data: string | Buffer): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
};

const readRegistry = (): Record<string, InstalledApp> => {
  try {
    return JSON.parse(readFileSync(registryFile(), "utf8")) as Record<
      string,
      InstalledApp
    >;
  } catch {
    return {};
  }
};

const writeRegistry = (registry: Record<string, InstalledApp>): void =>
  writeAtomic(registryFile(), JSON.stringify(registry, null, 2));

export const installedApps = (): InstalledApp[] =>
  Object.values(readRegistry());

// ---- Launcher entries ------------------------------------------------------

/** How the OS starts this app: the exe, plus the app folder in a dev run. */
const launchCommand = (): string[] => {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  return process.defaultApp
    ? [process.execPath, app.getAppPath()]
    : [process.execPath];
};

const linuxDesktopFile = (id: string): string =>
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "applications",
    `abacusai-bot-app-${id}.desktop`
  );

const windowsShortcut = (entry: InstalledApp): string =>
  join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${entry.title.replace(/[<>:"/\\|?*]/g, " ").trim() || "App"}.lnk`
  );

/** Each app its own taskbar identity on Windows. */
const appUserModelId = (id: string): string => `ai.abacus.bot.app.${id}`;

// The .desktop spec: quote arguments holding spaces; escape `"`, `` ` ``, `$`, `\`.
const desktopQuote = (arg: string): string =>
  /[\s"`$\\]/.test(arg) ? `"${arg.replace(/(["`$\\])/g, "\\$1")}"` : arg;

const writeLauncher = (entry: InstalledApp): void => {
  const png = appIconPng(entry.title, entry.id);
  writeAtomic(join(appDir(entry.id), "icon.png"), png);
  const link = `abacusaibot://app?id=${entry.id}`;
  if (process.platform === "win32") {
    const ico = join(appDir(entry.id), "icon.ico");
    writeAtomic(ico, pngToIco(png));
    const [target, ...args] = launchCommand();
    shell.writeShortcutLink(windowsShortcut(entry), "create", {
      target: target!,
      args: [...args.map((a) => `"${a}"`), link].join(" "),
      icon: ico,
      iconIndex: 0,
      appUserModelId: appUserModelId(entry.id),
      description: entry.title,
    });
    return;
  }
  if (process.platform === "linux") {
    const exec = [...launchCommand(), link].map(desktopQuote).join(" ");
    writeAtomic(
      linuxDesktopFile(entry.id),
      [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${entry.title.replace(/[\r\n]/g, " ")}`,
        `Exec=${exec}`,
        `Icon=${join(appDir(entry.id), "icon.png")}`,
        "Terminal=false",
        "Categories=Utility;",
        `StartupWMClass=abacusai-bot-app-${entry.id}`,
        "",
      ].join("\n")
    );
    return;
  }
  // macOS: needs a small .app in ~/Applications (Info.plist, a launcher
  // running `open abacusaibot://app?id=...`, an .icns). Not built in the spike.
  throw new Error(
    "Installing an artifact as an app is not built for macOS yet."
  );
};

const removeLauncher = (entry: InstalledApp): void => {
  if (process.platform === "win32")
    rmSync(windowsShortcut(entry), { force: true });
  if (process.platform === "linux")
    rmSync(linuxDesktopFile(entry.id), { force: true });
};

/** The page's own <title>: the artifact's name, where the row only has "index.html". */
const pageTitle = (path: string): string | null => {
  const match = /<title>([^<]{1,120})<\/title>/i.exec(
    readFileSync(path, "utf8")
  );
  const text = match?.[1]
    ?.replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
  return text || null;
};

export const installArtifactApp = (
  path: string,
  title: string
): InstalledApp => {
  if (!isArtifactPage(path) || !existsSync(path))
    throw new Error("Only an artifact page can be installed as an app.");
  const id = appIdFor(path);
  const registry = readRegistry();
  const entry: InstalledApp = {
    id,
    path,
    title: pageTitle(path) ?? (title.trim() || basename(dirname(path))),
    installedAt: registry[id]?.installedAt ?? new Date().toISOString(),
  };
  writeLauncher(entry);
  registry[id] = entry;
  writeRegistry(registry);
  return entry;
};

/** Removes the launcher entry and icon; keeps the saved data unless asked. */
export const uninstallArtifactApp = (path: string): void => {
  const id = appIdFor(path);
  const registry = readRegistry();
  const entry = registry[id];
  if (!entry) return;
  windows.get(id)?.close();
  removeLauncher(entry);
  rmSync(join(appDir(id), "icon.png"), { force: true });
  rmSync(join(appDir(id), "icon.ico"), { force: true });
  delete registry[id];
  writeRegistry(registry);
};

// ---- Saved data ------------------------------------------------------------

const MAX_KEY = 200;
const MAX_STORE_BYTES = 5 * 1024 * 1024;

const storeFile = (id: string): string => join(appDir(id), "store.json");

const readStore = (id: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(storeFile(id), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

const validKey = (key: unknown): string => {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY)
    throw new Error("A store key is a string of 1 to 200 characters.");
  return key;
};

/**
 * The store for one app's window, on that window's own IPC: no other page
 * (the main window, another app) can reach it, and it never sees another
 * app's data.
 */
const serveStore = (contents: WebContents, id: string): void => {
  contents.ipc.handle("artifact-app:store-get", (_event, key: unknown) => {
    const value = readStore(id)[validKey(key)];
    return value === undefined ? null : value;
  });
  contents.ipc.handle("artifact-app:store-keys", () =>
    Object.keys(readStore(id))
  );
  contents.ipc.handle(
    "artifact-app:store-set",
    (_event, key: unknown, value: unknown) => {
      const store = readStore(id);
      if (value === null || value === undefined) delete store[validKey(key)];
      else store[validKey(key)] = JSON.parse(JSON.stringify(value)) as unknown;
      const text = JSON.stringify(store);
      if (Buffer.byteLength(text) > MAX_STORE_BYTES)
        throw new Error("This app's saved data is over 5 MB.");
      writeAtomic(storeFile(id), text);
    }
  );
};

// ---- The window --------------------------------------------------------------

const windows = new Map<string, BaseWindow>();

export const artifactAppWindowCount = (): number => windows.size;

const missingPage = (title: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>` +
      `<body style="font:15px system-ui;padding:32px">This app's page was deleted. ` +
      `Uninstall it from the Artifacts list.</body>`
  )}`;

/** Opens (or focuses) the window of an installed app. False when unknown. */
export const openArtifactApp = (
  id: string,
  onAllClosed: () => void
): boolean => {
  const entry = readRegistry()[id];
  if (!entry) return false;
  const open = windows.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    return true;
  }

  const partition = `persist:artifact-app-${id}`;
  const appSession = session.fromPartition(partition);
  // Today's sandbox: no permissions (camera, notifications, ...), no downloads.
  appSession.setPermissionRequestHandler((_wc, _perm, callback) =>
    callback(false)
  );
  appSession.setPermissionCheckHandler(() => false);
  appSession.on("will-download", (event) => event.preventDefault());

  const window = new BaseWindow({
    width: 1040,
    height: 760,
    minWidth: 360,
    minHeight: 300,
    title: entry.title,
    icon: join(appDir(id), "icon.png"),
    show: false,
  });
  if (process.platform === "win32")
    window.setAppDetails({
      appId: appUserModelId(id),
      appIconPath: join(appDir(id), "icon.ico"),
    });
  window.setMenuBarVisibility(false);
  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      additionalArguments: ["--abacus-window=artifact-app"],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.contentView.addChildView(view);
  const fit = (): void => {
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  window.on("resize", fit);

  const contents = view.webContents;
  serveStore(contents, id);
  const pageUrl = `file://${entry.path}`;
  // The page stays itself: no navigation away, no new windows. Web links go to
  // the user's browser.
  contents.on("will-navigate", (event, url) => {
    if (url.split("#")[0] === pageUrl) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(entry.title);
  });

  const load = (): void => {
    if (existsSync(entry.path)) void contents.loadFile(entry.path);
    else void contents.loadURL(missingPage(entry.title));
  };
  load();
  contents.once("did-finish-load", () => window.show());

  // The agent rewrites index.html in place; reload on any change in the folder
  // (debounced: a save is a write plus a version file).
  let reloadTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(entry.path), (_event, name) => {
      if (name !== null && name !== basename(entry.path)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (!contents.isDestroyed()) load();
      }, 300);
    });
  } catch (error) {
    console.warn("[artifact-app] cannot watch", entry.path, error);
  }

  windows.set(id, window);
  window.on("closed", () => {
    watcher?.close();
    clearTimeout(reloadTimer);
    if (!contents.isDestroyed()) contents.close();
    windows.delete(id);
    if (windows.size === 0) onAllClosed();
  });
  return true;
};
