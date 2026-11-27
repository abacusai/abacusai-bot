/**
 * Apps the agent made in a chat (a served folder, an html file, an `artifact`
 * page). A page presented as a tool or game is kept the moment it is presented:
 * its own copy and its own data store, so what the user enters in the chat
 * preview is safe from the first minute. "Install as app" then only adds the
 * launcher (Start menu, Applications, the app launcher); Uninstall takes it
 * away again. A kept app is listed on the Artifacts page (Open, Install,
 * Delete).
 *
 * Keeping copies the page's folder into the app's own place, so the app
 * keeps working when the chat's folder is cleaned up or its server is gone:
 * the window serves the copy itself (`abacus-app://<id>/`), offline, with the
 * bot's main window closed and nobody signed in. When the agent changes the
 * source folder, a new copy (a version) is made and the window reloads; the
 * last versions are kept for "Undo last change". The data the page saves
 * lives apart from the code (store.ts) and is shared with the chat preview.
 *
 * Under `<profile base>/installed-apps/` (one place for every account here):
 *   registry.json           { [id]: InstalledApp }
 *   shortcuts.txt           Windows: every launcher path, for the uninstaller
 *   <id>/versions/<n>/      copies of the page's folder
 *   <id>/icon.png|ico       the launcher icon
 *   <id>/data/              the saved data (store.ts)
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isLoopbackUrl } from "@abacus-ai/agent/deliverable-url";
import { InvalidInputError } from "@abacus-ai/contract/service-errors";
import { isArtifactPage } from "@abacus-ai/contract/share";
import {
  app,
  BaseWindow,
  dialog,
  Menu,
  net,
  screen,
  session,
  shell,
  webContents,
  WebContentsView,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron";

import { profileBaseDir } from "../../profile-home";
import {
  portOnlyServed,
  previewDirectory,
  revivePreview,
  servedDirectoryNow,
} from "../agent-tools/served-previews";
import { htmlPagesIn } from "../agent-tools/static-server";
import { BROWSER_PARTITION } from "../browser/connected-sites";
import { nativeLocaleTag, nativeT } from "../config/native-language";
import { scrubForShare } from "../providers/abacus-share-service";
import { bundlePage } from "../providers/share-bundle";
import {
  appUserModelId,
  iconFile,
  removeIconFiles,
  removeLaunchers,
  writeLaunchers,
} from "./launchers";
import {
  deleteStore,
  exportCsv,
  exportJson,
  flushAllStores,
  importLocalStorage,
  lastBackupAt,
  markImported,
  serveStore,
  setStoreRoot,
  wasImported,
  writeAtomic,
} from "./store";

export { flushAllStores };

export const APP_SCHEME = "abacus-app";

export interface InstalledApp {
  id: string;
  title: string;
  /** The folder the agent made the page in, and the page in it. */
  dir: string;
  entry: string;
  /** Made by the `artifact` tool: its versions folder is not copied. */
  artifact: boolean;
  /**
   * Where its saved data lives: one store per source folder, as the folder's
   * pages share one localStorage when served. Absent: the app's own id.
   */
  dataId?: string;
  /** "page": a page with no files of its own beside it, copied alone. */
  copies?: "page" | "folder";
  /** The chat it was made in, for "Edit in a chat". */
  sessionId: string | null;
  installedAt: string;
  versions: number[];
  current: number;
  /** The source folder as the newest version copied it. */
  sourceSig: string;
  /** The newest version a window showed (for installed_app_edit_seen). */
  seen: number;
  /** When the agent's last change was copied (ms). */
  updatedAt?: number;
  launchers: string[];
  /**
   * It has launchers: the user installed it. False: kept only (the agent
   * presented it as a tool or game). Absent: installed by an earlier build.
   */
  installed?: boolean;
  /** The first open's line that its data is kept here was shown. */
  noticeShown?: boolean;
}

export interface AppsDeps {
  /** The folder a chat works in, or null. */
  workspaceOf(sessionId: string): string | null;
  funnel(step: string, detail?: string): void;
  /** Opens a chat in the main window. */
  openChat(sessionId: string): void;
  /** The last app window closed. */
  onAllClosed(): void;
  /** An app was installed or uninstalled: the main window's buttons follow. */
  changed(): void;
}

let deps: AppsDeps = {
  workspaceOf: () => null,
  funnel: () => undefined,
  openChat: () => undefined,
  onAllClosed: () => undefined,
  changed: () => undefined,
};

const KEEP_VERSIONS = 5;
/** Changes this close together are one change: the agent edits in steps. */
const ONE_CHANGE_MS = 3 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5000;

const root = (): string => join(profileBaseDir(), "installed-apps");
const registryFile = (): string => join(root(), "registry.json");
const appDir = (id: string): string => join(root(), id);
const versionDir = (id: string, n: number): string =>
  join(appDir(id), "versions", String(n));

const APP_LINK = /^abacusaibot:\/\/app\/?\?id=([a-f0-9]{16})$/i;

/** The app id a launcher link asks for, or null when it is not one. */
export const artifactAppLinkId = (raw: string | null): string | null =>
  raw == null ? null : (APP_LINK.exec(raw.trim())?.[1]?.toLowerCase() ?? null);

export const artifactAppLinkInArgv = (argv: readonly string[]): string | null =>
  argv.map(artifactAppLinkId).find((id) => id != null) ?? null;

const realDir = (dir: string): string => {
  try {
    return realpathSync(resolve(dir));
  } catch {
    // A deleted folder keeps the id of the path it had.
    return resolve(dir);
  }
};

/** `inner` is `outer` or inside it. */
const within = (outer: string, inner: string): boolean =>
  inner === outer || inner.startsWith(`${outer}${sep}`);

const hash16 = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * A folder's saved data: the chat preview (served or as a file) and the
 * installed window reach a page by different routes and share one store, as
 * the folder's pages share one localStorage when served.
 */
const dataIdFor = (dir: string): string => hash16(realDir(dir));

/**
 * An app is one page: chats share a workspace, and two of them can put
 * their pages in one folder ("game/index.html", "game/puppies.html").
 */
const appIdFor = (dir: string, entry: string): string =>
  entry === "index.html" ? dataIdFor(dir) : hash16(`${realDir(dir)}\0${entry}`);

const dataOf = (app: InstalledApp): string => app.dataId ?? app.id;

// ---- Registry ----------------------------------------------------------------

let registryCache: Record<string, InstalledApp> | null = null;

const readRegistry = (): Record<string, InstalledApp> => {
  if (registryCache) return registryCache;
  try {
    registryCache = JSON.parse(readFileSync(registryFile(), "utf8")) as Record<
      string,
      InstalledApp
    >;
  } catch {
    registryCache = {};
  }
  return registryCache;
};

const saveRegistry = (): void => {
  const registry = readRegistry();
  writeAtomic(registryFile(), JSON.stringify(registry, null, 2));
  // UTF-16LE with a BOM: the uninstaller reads it with FileReadUTF16LE, so
  // names in any script (a Hindi app's shortcut) are found.
  if (process.platform === "win32")
    writeAtomic(
      join(root(), "shortcuts.txt"),
      Buffer.from(
        `\ufeff${Object.values(registry)
          .flatMap((a) => a.launchers)
          .join("\r\n")}\r\n`,
        "utf16le"
      )
    );
};

export const installedApps = (): InstalledApp[] =>
  Object.values(readRegistry());

const hasLauncher = (entry: InstalledApp): boolean => entry.installed !== false;

/** Kept and installed apps, for the main window's list. */
export const appsList = (): Array<{
  id: string;
  title: string;
  installed: boolean;
}> =>
  installedApps().map((a) => ({
    id: a.id,
    title: a.title,
    installed: hasLauncher(a),
  }));

// ---- What a page is ----------------------------------------------------------

interface Source {
  dir: string;
  entry: string;
  artifact: boolean;
  /** The served URL it was presented as, when it was. */
  url: string | null;
}

const HTML = /\.html?$/i;

/** The page a presented URL or file stands for, or null when none can be installed. */
const sourceOf = async (target: string): Promise<Source | null> => {
  if (isLoopbackUrl(target)) {
    const dir = previewDirectory(target);
    if (dir == null || !existsSync(dir)) return null;
    let entry = decodeURIComponent(new URL(target).pathname).replace(
      /^\/+/,
      ""
    );
    const full = resolve(dir, entry);
    if (full !== dir && !full.startsWith(`${dir}${sep}`)) return null;
    if (
      entry === "" ||
      statSync(full, { throwIfNoEntry: false })?.isDirectory()
    ) {
      const page = (await htmlPagesIn(full))[0];
      if (page == null) return null;
      entry = relative(dir, join(full, page));
    }
    if (!HTML.test(entry) || !existsSync(join(dir, entry))) return null;
    return {
      dir,
      entry: entry.split(sep).join("/"),
      artifact: false,
      url: target,
    };
  }
  const path = target.startsWith("file:") ? fileURLToPath(target) : target;
  if (!HTML.test(path) || !existsSync(path)) return null;
  return {
    dir: dirname(path),
    entry: basename(path),
    artifact:
      isArtifactPage(path) && existsSync(join(dirname(path), "versions")),
    url: null,
  };
};

/**
 * The installed app a page file belongs to: under the folder of its entry
 * page (the deepest one), never in node_modules. A page nobody installed has
 * no store: a file saved into the same tree later (a fetched page, a repo's
 * docs) must not read the app's data.
 */
const installedAppFor = (path: string): InstalledApp | null => {
  if (/[\\/]node_modules[\\/]/.test(path)) return null;
  const real = join(realDir(dirname(path)), basename(path));
  let best: { app: InstalledApp; base: string } | null = null;
  for (const app of installedApps()) {
    const base = realDir(join(app.dir, dirname(app.entry)));
    if (!real.startsWith(`${base}${sep}`)) continue;
    if (best == null || base.length > best.base.length) best = { app, base };
  }
  return best?.app ?? null;
};

/** The file a served URL shows, for a folder `serve` is serving now. */
const servedFile = (url: string): { dir: string; file: string } | null => {
  const dir = servedDirectoryNow(url);
  if (dir == null) return null;
  const file = resolve(dir, `.${decodeURIComponent(new URL(url).pathname)}`);
  if (file !== dir && !file.startsWith(`${dir}${sep}`)) return null;
  return {
    dir,
    file: statSync(file, { throwIfNoEntry: false })?.isDirectory()
      ? join(file, "index.html")
      : file,
  };
};

/**
 * The store a page shown at `url` keeps its data in, or null when it has
 * none: an installed app's window, or a preview of a page of an installed
 * app (as a file, or from a folder `serve` is serving right now: a port
 * remembered from before may be another program's by now).
 */
export const storeIdForUrl = (url: string): string | null => {
  try {
    if (url.startsWith(`${APP_SCHEME}://`)) {
      const app = readRegistry()[new URL(url).hostname];
      return app ? dataOf(app) : null;
    }
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url.split("#")[0]!.split("?")[0]!);
      const app = HTML.test(path) ? installedAppFor(path) : null;
      return app ? dataOf(app) : null;
    }
    if (isLoopbackUrl(url)) {
      const served = servedFile(url);
      const app = served ? installedAppFor(served.file) : null;
      return app ? dataOf(app) : null;
    }
  } catch {
    // Not a URL we serve.
  }
  return null;
};

/**
 * Whether what this origin's own localStorage holds may be read into the
 * store: a loopback origin is every server that ever had its port, so only
 * when `serve` has only ever given that port to this page's folder.
 */
const mayImport = (url: string): boolean => {
  if (!isLoopbackUrl(url)) return true;
  const served = servedFile(url);
  return served != null && portOnlyServed(url, served.dir);
};

/** Whether a <webview> or preview about to load `src` is a page with a store. */
export const isPagePreviewUrl = (src: string): boolean =>
  src.startsWith("file:") && storeIdForUrl(src) != null;

/**
 * Gives a view's page its saved data (store.ts), when the page has one.
 * `agentCanDrive`: the chat's browser, where the agent tests pages too.
 */
export const servePageStore = (
  contents: WebContents,
  agentCanDrive = false
): void => serveStore(contents, storeIdForUrl, mayImport, agentCanDrive);

// ---- Copies ----------------------------------------------------------------

/** Worded for the user: the app shows it as it is (rpc/errors.ts). */
export class AppInstallError extends InvalidInputError {}

interface SourceFile {
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * Files a page loads from beside it: a src/href, a CSS url(), an import or
 * fetch, or an asset name in a script ("sprite.png"). None: the page is
 * whole on its own, and only it is copied, not the folder it shares. Case
 * matters: `url(` is CSS, `URL(` a script.
 */
const LOCAL_REF =
  /(?:\b(?:src|href|data|poster)\s*=\s*["']|url\(\s*["']?|\bimport\s*\(?\s*(?:[^'"]*\bfrom\s*)?["']|fetch\(\s*["'])(?!https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/|about:)[^"')\s]+|["'][^"'\s:]+\.(?:png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|m4a|mp4|webm|json|js|mjs|css|woff2?|ttf|otf|glb|gltf)["']/;

const usesFilesBeside = (page: string): boolean => {
  try {
    return LOCAL_REF.test(readFileSync(page, "utf8"));
  } catch {
    return true;
  }
};

/** The files a copy takes: no dot files, node_modules, or an artifact's versions. */
const listFiles = (
  dir: string,
  artifact: boolean,
  onlyPage: string | null = null
): SourceFile[] => {
  const files: SourceFile[] = [];
  let bytes = 0;
  if (onlyPage != null) {
    const stat = statSync(join(dir, onlyPage));
    return [{ rel: onlyPage, size: stat.size, mtimeMs: stat.mtimeMs }];
  }
  const walk = (at: string): void => {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const full = join(at, item.name);
      const rel = relative(dir, full);
      if (artifact && rel === "versions") continue;
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) {
        const stat = statSync(full);
        bytes += stat.size;
        files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
        if (bytes > MAX_BYTES || files.length > MAX_FILES)
          throw new AppInstallError(nativeT("installedAppTooBig"));
      }
    }
  };
  walk(dir);
  return files;
};

const signature = (files: SourceFile[]): string =>
  createHash("sha256")
    .update(
      files
        .map((f) => `${f.rel}\0${f.size}\0${Math.round(f.mtimeMs)}`)
        .sort()
        .join("\n")
    )
    .digest("hex");

const copyVersion = (
  id: string,
  n: number,
  dir: string,
  files: SourceFile[]
): void => {
  const target = versionDir(id, n);
  const part = `${target}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  for (const file of files) {
    const to = join(part, file.rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(dir, file.rel), to);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(part, target);
};

/** The page's own <title>, else null. */
const pageTitle = (path: string): string | null => {
  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const text = /<title[^>]*>([^<]{1,120})<\/title>/i
    .exec(html)?.[1]
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
};

/** A name no other installed app has: launchers side by side stay apart. */
const uniqueTitle = (wanted: string, id: string): string => {
  const taken = new Set(
    installedApps()
      .filter((a) => a.id !== id)
      .map((a) => a.title.toLocaleLowerCase())
  );
  let title = wanted;
  for (let n = 2; taken.has(title.toLocaleLowerCase()); n++)
    title = `${wanted} (${n})`;
  return title;
};

/**
 * What a served page had kept in its own localStorage (the in-app browser's,
 * per origin), read at its first install; the preview's preload does the same
 * whenever the page is shown there first.
 */
const readServedLocalStorage = async (
  url: string
): Promise<Record<string, string> | null> => {
  const origin = new URL(await revivePreview(url)).origin;
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
    },
  });
  const contents = view.webContents;
  try {
    // A path nothing answers: the origin's storage without the page's scripts.
    await contents
      .loadURL(`${origin}/.abacus-read-storage`)
      .catch(() => undefined);
    const text = (await contents.executeJavaScript(
      "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))"
    )) as string;
    return JSON.parse(text) as Record<string, string>;
  } finally {
    contents.close();
  }
};

// ---- Install, update, undo, uninstall ---------------------------------------

/**
 * What a page is for people: "app" when it keeps what they enter or is a game
 * (storage, a canvas) in the page or its scripts beside it; else "site", a
 * page to read, where Share stays the main action. Not an animation loop:
 * sites animate as they scroll.
 */
const APP_SIGNS =
  /\b(?:localStorage|sessionStorage|indexedDB)\b|abacus\.store|<canvas\b|getContext\(/;
const pageKind = (dir: string, entry: string): "app" | "site" => {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  if (APP_SIGNS.test(read(join(dir, entry)))) return "app";
  if (!usesFilesBeside(join(dir, entry))) return "site";
  let bytes = 0;
  const scripts = (at: string, depth: number): boolean => {
    let names: string[] = [];
    try {
      names = readdirSync(at);
    } catch {
      return false;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(at, name);
      if (/\.(?:m?js)$/.test(name)) {
        const text = read(full);
        bytes += text.length;
        if (APP_SIGNS.test(text)) return true;
        if (bytes > 2_000_000) return false;
      } else if (depth > 0 && !name.includes(".") && scripts(full, depth - 1))
        return true;
    }
    return false;
  };
  return scripts(dir, 2) ? "app" : "site";
};

export interface AppStatus {
  installable: boolean;
  /** Its app's id when it is kept or installed, else null. */
  appId: string | null;
  /** It has launchers. */
  installed: boolean;
  kind: "app" | "site";
}

export const appStatus = async (target: string): Promise<AppStatus> => {
  const source = await sourceOf(target).catch(() => null);
  if (source == null)
    return { installable: false, appId: null, installed: false, kind: "site" };
  const id = appIdFor(source.dir, source.entry);
  const entry = readRegistry()[id];
  return {
    installable: true,
    appId: entry ? id : null,
    installed: entry != null && hasLauncher(entry),
    kind: pageKind(source.dir, source.entry),
  };
};

/**
 * When this build first ran: a page made since is kept from its first
 * presentation, so whatever its own localStorage holds is the agent's testing,
 * never read in. A page from before may hold the user's rows there.
 */
const keptSince = (): number => {
  const marker = join(root(), "kept-since");
  try {
    return Number(readFileSync(marker, "utf8").trim()) || 0;
  } catch {
    const now = Date.now();
    try {
      writeAtomic(marker, String(now));
    } catch {
      // Asked again next time.
    }
    return now;
  }
};

const madeSince = (file: string, since: number): boolean => {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (stat == null) return false;
  const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  return born >= since;
};

/**
 * Keeps a presented tool or game: its copy and its store, no launcher. The
 * same rules as an install (one app per page, the chat's own folder, the size
 * caps); a page that is already kept or installed is left as it is.
 */
export const keepApp = async (
  target: string,
  sessionId: string | null
): Promise<{ id: string } | null> => {
  const source = await sourceOf(target);
  if (source == null) return null;
  const id = appIdFor(source.dir, source.entry);
  if (readRegistry()[id]) return { id };
  await registerApp(source, sessionId, false);
  deps.funnel("installed_app_kept");
  return { id };
};

/**
 * Gives a kept app its launchers, or keeps the page and gives it launchers in
 * one go (a page from before auto-keep, a site's Install).
 */
export const installApp = async (
  target: string,
  sessionId: string | null,
  /** Who asked: the row's button, or the agent after the user said yes. */
  by: "button" | "agent" = "button"
): Promise<{ id: string; title: string }> => {
  const source = await sourceOf(target);
  if (source == null)
    throw new AppInstallError(nativeT("installedAppCannotInstall"));
  const id = appIdFor(source.dir, source.entry);
  const existing = readRegistry()[id];
  if (existing && hasLauncher(existing)) return { id, title: existing.title };
  if (existing) await addLaunchers(existing);
  else await registerApp(source, sessionId, true);
  const entry = readRegistry()[id]!;
  deps.funnel(
    "installed_app_install",
    source.artifact ? "artifact" : source.url != null ? "site" : "file"
  );
  if (by === "agent") deps.funnel("installed_app_agent_install");
  return { id, title: entry.title };
};

/** By its id: the Artifacts page's Install on a kept app. */
export const installKeptApp = async (id: string): Promise<boolean> => {
  const entry = readRegistry()[id];
  if (!entry) return false;
  if (!hasLauncher(entry)) {
    await addLaunchers(entry);
    deps.funnel("installed_app_install", "kept");
  }
  return true;
};

const addLaunchers = async (entry: InstalledApp): Promise<void> => {
  entry.launchers = await writeLaunchers(entry, appDir(entry.id));
  entry.installed = true;
  saveRegistry();
  deps.changed();
};

/** A new app: its first copy, its data, and launchers when `launcher`. */
const registerApp = async (
  source: Source,
  sessionId: string | null,
  launcher: boolean
): Promise<void> => {
  const id = appIdFor(source.dir, source.entry);
  const dataId = dataIdFor(source.dir);
  const registry = readRegistry();

  const copies = usesFilesBeside(join(source.dir, source.entry))
    ? "folder"
    : "page";
  // Only what the chat made: never the home folder (or above it) copied
  // whole, nor anything outside the chat's own folder.
  const workspace = sessionId == null ? null : deps.workspaceOf(sessionId);
  const real = realDir(source.dir);
  const home = realDir(homedir());
  if (
    workspace == null ||
    !within(realDir(workspace), real) ||
    (copies === "folder" && (real === parse(real).root || within(real, home)))
  ) {
    deps.funnel(
      "installed_app_refused",
      launcher ? "too_broad" : "keep_too_broad"
    );
    throw new AppInstallError(nativeT("installedAppTooBroad"));
  }
  let files: SourceFile[];
  try {
    files = listFiles(
      source.dir,
      source.artifact,
      copies === "page" ? source.entry : null
    );
  } catch (error) {
    deps.funnel("installed_app_refused", launcher ? "too_big" : "keep_too_big");
    throw error;
  }
  copyVersion(id, 1, source.dir, files);

  // A page made since auto-keep has only the agent's tests in its own
  // localStorage: nothing to read in, ever.
  if (
    !wasImported(dataId) &&
    madeSince(join(source.dir, source.entry), keptSince())
  )
    markImported(dataId);
  else if (source.url != null && !wasImported(dataId))
    try {
      // The port's origin is every server that ever had it: only its data
      // when it only ever served this folder.
      if (portOnlyServed(source.url, source.dir))
        importLocalStorage(
          dataId,
          await readServedLocalStorage(source.url),
          null
        );
      markImported(dataId);
    } catch (error) {
      console.warn("[installed-app] could not read the page's old data", error);
    }

  const entry: InstalledApp = {
    id,
    title: uniqueTitle(
      pageTitle(join(source.dir, source.entry)) ?? basename(source.dir),
      id
    ),
    dir: source.dir,
    entry: source.entry,
    artifact: source.artifact,
    dataId,
    copies,
    sessionId,
    installedAt: new Date().toISOString(),
    versions: [1],
    current: 1,
    sourceSig: signature(files),
    seen: 0,
    launchers: [],
    installed: launcher,
  };
  if (launcher)
    try {
      entry.launchers = await writeLaunchers(entry, appDir(id));
    } catch (error) {
      rmSync(join(appDir(id), "versions"), { recursive: true, force: true });
      throw error;
    }
  registry[id] = entry;
  saveRegistry();
  watchSource(entry);
  // Previews of it open now were loaded without a store: they use it from now on.
  for (const contents of webContents.getAllWebContents())
    if (storeIdForUrl(contents.getURL()) === dataId) contents.reload();
  deps.changed();
};

/** Copies the source folder again when the agent changed it. True when it did. */
const updateFromSource = (id: string): boolean => {
  const entry = readRegistry()[id];
  if (!entry || !existsSync(join(entry.dir, entry.entry))) return false;
  let files: SourceFile[];
  try {
    files = listFiles(
      entry.dir,
      entry.artifact,
      entry.copies === "page" ? entry.entry : null
    );
  } catch (error) {
    console.warn("[installed-app] not updated:", (error as Error).message);
    return false;
  }
  const sig = signature(files);
  if (sig === entry.sourceSig) return false;
  // The agent's steps on one request make one version, so "Undo last change"
  // goes back to before the request, not before its last step.
  const newest = Math.max(...entry.versions);
  const sameChange =
    entry.versions.length > 1 &&
    entry.current === newest &&
    Date.now() - (entry.updatedAt ?? 0) < ONE_CHANGE_MS;
  const n = sameChange ? newest : newest + 1;
  copyVersion(id, n, entry.dir, files);
  if (!sameChange) entry.versions.push(n);
  entry.current = n;
  entry.sourceSig = sig;
  entry.updatedAt = Date.now();
  for (const old of entry.versions.splice(
    0,
    Math.max(0, entry.versions.length - KEEP_VERSIONS)
  ))
    rmSync(versionDir(id, old), { recursive: true, force: true });
  saveRegistry();
  reloadWindow(id);
  return true;
};

/**
 * The chat's folder back to a version's files, so the agent's next edit and a
 * reinstall start from it: its files written over, and files only the undone
 * version had removed. Not a change of the agent's: no new version.
 */
const writeBack = (
  entry: InstalledApp,
  from: number,
  dropped: number
): void => {
  if (!existsSync(entry.dir)) return;
  const kept = new Set(
    listFiles(versionDir(entry.id, from), false).map((f) => f.rel)
  );
  for (const rel of kept) {
    const to = join(entry.dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(versionDir(entry.id, from), rel), to);
  }
  for (const file of listFiles(versionDir(entry.id, dropped), false))
    if (!kept.has(file.rel)) rmSync(join(entry.dir, file.rel), { force: true });
  entry.sourceSig = signature(
    listFiles(
      entry.dir,
      entry.artifact,
      entry.copies === "page" ? entry.entry : null
    )
  );
};

/** Back to the version before the current one; the newer copy goes. */
export const undoLastChange = (id: string): boolean => {
  const entry = readRegistry()[id];
  if (!entry) return false;
  const at = entry.versions.indexOf(entry.current);
  if (at <= 0) return false;
  const dropped = entry.current;
  entry.versions.splice(at, 1);
  entry.current = entry.versions[at - 1]!;
  entry.seen = entry.current;
  try {
    writeBack(entry, entry.current, dropped);
  } catch (error) {
    console.warn("[installed-app] undo not written back", id, error);
  }
  saveRegistry();
  rmSync(versionDir(id, dropped), { recursive: true, force: true });
  reloadWindow(id);
  return true;
};

const askKeepData = async (
  entry: InstalledApp,
  parent: BaseWindow | undefined,
  words: { action: string; question: string; detail: string }
): Promise<{ yes: boolean; deleteData: boolean }> => {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: [nativeT(words.action), nativeT("installedAppCancel")],
    defaultId: 0,
    cancelId: 1,
    message: nativeT(words.question, { name: entry.title }),
    detail: nativeT(words.detail),
    checkboxLabel: nativeT("installedAppDeleteData"),
    checkboxChecked: false,
  };
  const answer = await (parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options));
  return { yes: answer.response === 0, deleteData: answer.checkboxChecked };
};

/** The app gone from this computer: window, launchers, code; its data when asked. */
const removeApp = (entry: InstalledApp, deleteData: boolean): void => {
  const id = entry.id;
  windows.get(id)?.close();
  watchers.get(id)?.close();
  watchers.delete(id);
  removeLaunchers(entry.launchers);
  delete readRegistry()[id];
  removeIconFiles(appDir(id));
  for (const name of ["versions", "window.json"])
    rmSync(join(appDir(id), name), { recursive: true, force: true });
  // Its folder's data, unless another app of that folder uses it.
  const dataId = dataOf(entry);
  if (
    deleteData &&
    !installedApps().some((other) => dataOf(other) === dataId)
  ) {
    deleteStore(dataId);
    rmSync(appDir(dataId), { recursive: true, force: true });
  }
  // A folder left with nothing in it goes too.
  try {
    rmdirSync(appDir(id));
  } catch {
    // Its data is still there.
  }
  saveRegistry();
  deps.changed();
};

/**
 * Asks, then removes the app's launchers: it stays kept (the Artifacts page),
 * with its data. Ticking "Also delete its data" removes the app as Delete does.
 * False when they cancelled.
 */
export const uninstallApp = async (
  id: string,
  parent?: BaseWindow
): Promise<boolean> => {
  const entry = readRegistry()[id];
  if (!entry || !hasLauncher(entry)) return false;
  const answer = await askKeepData(entry, parent, {
    action: "installedAppUninstall",
    question: "installedAppUninstallQuestion",
    detail: "installedAppUninstallDetail",
  });
  if (!answer.yes) return false;
  if (answer.deleteData) removeApp(entry, true);
  else {
    windows.get(id)?.close();
    removeLaunchers(entry.launchers);
    entry.launchers = [];
    entry.installed = false;
    saveRegistry();
    deps.changed();
  }
  deps.funnel(
    "installed_app_uninstall",
    answer.deleteData ? "delete_data" : "keep_data"
  );
  return true;
};

/** Asks, then removes a kept or installed app; its data too when ticked. */
export const deleteApp = async (
  id: string,
  parent?: BaseWindow
): Promise<boolean> => {
  const entry = readRegistry()[id];
  if (!entry) return false;
  const answer = await askKeepData(entry, parent, {
    action: "installedAppDelete",
    question: "installedAppDeleteQuestion",
    detail: "installedAppDeleteDetail",
  });
  if (!answer.yes) return false;
  removeApp(entry, answer.deleteData);
  deps.funnel(
    "installed_app_delete",
    answer.deleteData ? "delete_data" : "keep_data"
  );
  return true;
};

/** Over this, a copy is refused: a file people mail or message. */
const COPY_MAX_BYTES = 25 * 1024 * 1024;

const safeFileName = (title: string): string =>
  title
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "App";

/**
 * "Send a copy": the page as one html file (what Share would publish, the
 * files beside it folded in), saved where the user picks. Code only: the
 * data the user saved in it is never in the file. False when cancelled.
 */
const saveCopy = async (
  dir: string,
  entry: string,
  title: string,
  parent: BaseWindow | undefined
): Promise<boolean> => {
  const page = join(dir, entry);
  let html: string;
  try {
    html = await bundlePage(
      readFileSync(page, "utf8"),
      realDir(dirname(page)),
      scrubForShare
    );
  } catch {
    throw new AppInstallError(nativeT("installedAppCopyFailed"));
  }
  if (Buffer.byteLength(html, "utf8") > COPY_MAX_BYTES)
    throw new AppInstallError(nativeT("installedAppCopyTooBig"));
  const options: Electron.SaveDialogOptions = {
    title: nativeT("installedAppCopyTitle"),
    message: nativeT("installedAppCopyTitle"),
    defaultPath: join(app.getPath("documents"), `${safeFileName(title)}.html`),
    filters: [{ name: "HTML", extensions: ["html"] }],
  };
  const { canceled, filePath } = await (parent
    ? dialog.showSaveDialog(parent, options)
    : dialog.showSaveDialog(options));
  if (canceled || !filePath) return false;
  writeFileSync(filePath, html);
  deps.funnel("installed_app_copy");
  return true;
};

/** A presented page (URL or path), or an app's current copy by its id. */
export const sendCopy = async (
  target: { page: string } | { id: string },
  parent?: BaseWindow
): Promise<boolean> => {
  if ("id" in target) {
    const entry = readRegistry()[target.id];
    if (!entry) return false;
    return saveCopy(
      versionDir(entry.id, entry.current),
      entry.entry,
      entry.title,
      parent
    );
  }
  const source = await sourceOf(target.page);
  if (source == null)
    throw new AppInstallError(nativeT("installedAppCannotInstall"));
  return saveCopy(
    source.dir,
    source.entry,
    pageTitle(join(source.dir, source.entry)) ?? parse(source.entry).name,
    parent
  );
};

/** Saves the app's data where the user picks, as a CSV table or JSON. */
const exportData = async (id: string, parent: BaseWindow): Promise<void> => {
  const entry = readRegistry()[id];
  if (!entry) return;
  const name = entry.title.replace(/[<>:"/\\|?*]/g, " ").trim() || "App";
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: nativeT("installedAppExportTitle"),
    defaultPath: `${nativeT("installedAppExportFile", { name })}.csv`,
    filters: [
      { name: nativeT("installedAppExportCsv"), extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });
  if (canceled || !filePath) return;
  const json = /\.json$/i.test(filePath);
  writeFileSync(
    filePath,
    json ? exportJson(dataOf(entry)) : exportCsv(dataOf(entry))
  );
  deps.funnel("installed_app_export", json ? "json" : "csv");
};

// ---- Watching the source ----------------------------------------------------

const watchers = new Map<string, FSWatcher>();

const watchSource = (entry: InstalledApp): void => {
  if (watchers.has(entry.id) || !existsSync(entry.dir)) return;
  let timer: NodeJS.Timeout | undefined;
  const changed = (_event: string, name: string | Buffer | null): void => {
    const file = String(name ?? "");
    if (/(^|[\\/])(\.|node_modules([\\/]|$))/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        updateFromSource(entry.id);
      } catch (error) {
        console.warn("[installed-app] update failed", entry.id, error);
      }
    }, 1000);
  };
  try {
    const watcher = watch(entry.dir, { recursive: true }, changed);
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(entry.id);
    });
    watchers.set(entry.id, watcher);
  } catch (error) {
    console.warn("[installed-app] cannot watch", entry.dir, error);
  }
};

/** At start: catch up on edits made while the app was closed, then watch. */
export const startInstalledApps = (appDeps: AppsDeps): void => {
  deps = appDeps;
  setStoreRoot(root());
  // Written at this build's first start, before any page is kept.
  keptSince();
  // An earlier build wrote the uninstaller's list as UTF-8: written again now.
  if (process.platform === "win32" && installedApps().length > 0)
    saveRegistry();
  for (const entry of installedApps()) {
    try {
      updateFromSource(entry.id);
    } catch (error) {
      console.warn("[installed-app] update failed", entry.id, error);
    }
    watchSource(entry);
  }
  void restoreLaunchers();
};

/**
 * The first run after this app was installed or updated: launchers missing
 * for installed apps are made again (uninstalling the bot removed them, and a
 * reinstall keeps the apps and their data). Only then, so a shortcut the user
 * deleted on purpose is not brought back at every start. The uninstaller
 * deletes the marker (build/installer.nsh).
 */
const restoreLaunchers = async (): Promise<void> => {
  const marker = join(root(), "launchers-version");
  let seen = "";
  try {
    seen = readFileSync(marker, "utf8").trim();
  } catch {
    // Never run, or the bot was uninstalled since.
  }
  const version = app.getVersion();
  if (seen === version) return;
  let changed = false;
  for (const entry of installedApps()) {
    if (!hasLauncher(entry)) continue;
    if (entry.launchers.length > 0 && entry.launchers.every(existsSync))
      continue;
    try {
      entry.launchers = await writeLaunchers(entry, appDir(entry.id));
      changed = true;
    } catch (error) {
      console.warn("[installed-app] launcher not restored", entry.id, error);
    }
  }
  if (changed) saveRegistry();
  try {
    writeAtomic(marker, version);
  } catch {
    // Checked again next start.
  }
};

// ---- The window --------------------------------------------------------------

const windows = new Map<string, BaseWindow>();
const views = new Map<string, WebContents>();

const reloadWindow = (id: string): void => {
  const contents = views.get(id);
  if (contents && !contents.isDestroyed()) contents.reload();
  refreshMenu(id);
};

const pageUrl = (entry: InstalledApp): string =>
  `${APP_SCHEME}://${entry.id}/${entry.entry
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/** Serves the current copy of app `id` on its own partition. */
const handleScheme = (appSession: Electron.Session, id: string): void => {
  if (appSession.protocol.isProtocolHandled(APP_SCHEME)) return;
  appSession.protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const entry = readRegistry()[url.hostname];
    if (url.hostname !== id || !entry)
      return new Response("Not found", { status: 404 });
    const base = versionDir(id, entry.current);
    let file: string;
    try {
      file = resolve(base, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!file.startsWith(`${base}${sep}`))
      return new Response("Not found", { status: 404 });
    if (statSync(file, { throwIfNoEntry: false })?.isDirectory())
      file = join(file, "index.html");
    if (!existsSync(file)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
};

const NOTICE_HEIGHT = 30;
const NOTICE_MS = 10_000;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const noticeHtml = (text: string): string =>
  [
    "<!doctype html><meta charset=utf-8><style>",
    ":root{color-scheme:light dark;--bg:#f4f4f5;--fg:#3f3f46;--line:#e4e4e7}",
    "@media (prefers-color-scheme:dark){:root{--bg:#1c1c1f;--fg:#d4d4d8;--line:#2e2e33}}",
    "html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}",
    "body{display:flex;align-items:center;justify-content:center;gap:6px;",
    "font:12px system-ui,sans-serif;border-top:1px solid var(--line);box-sizing:border-box}",
    "</style><body><span aria-hidden=true>✓</span><span>",
    escapeHtml(text),
    "</span></body>",
  ].join("");

/** "Last backup: <when>", or that there is none yet. */
const backupLine = (entry: InstalledApp): string => {
  const at = lastBackupAt(dataOf(entry));
  if (at == null) return nativeT("installedAppNoBackupYet");
  let when: string;
  try {
    when = new Intl.DateTimeFormat(nativeLocaleTag(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(at);
  } catch {
    when = at.toLocaleString();
  }
  return nativeT("installedAppLastBackup", { time: when });
};

const menuItems = (id: string): MenuItemConstructorOptions[] => {
  const entry = readRegistry()[id];
  const window = windows.get(id);
  if (!entry || !window) return [];
  return [
    {
      label: nativeT("installedAppEditInChat"),
      enabled: entry.sessionId != null,
      click: () => {
        if (entry.sessionId) deps.openChat(entry.sessionId);
      },
    },
    {
      label: nativeT("installedAppUndo"),
      enabled: entry.versions.indexOf(entry.current) > 0,
      click: () => {
        if (undoLastChange(id)) deps.funnel("installed_app_undo");
      },
    },
    { type: "separator" },
    {
      label: nativeT("installedAppExport"),
      click: () => void exportData(id, window),
    },
    { label: backupLine(entry), enabled: false },
    {
      label: nativeT("installedAppCopyMenu"),
      click: () =>
        void sendCopy({ id }, window).catch((error: unknown) =>
          dialog.showMessageBox(window, {
            type: "warning",
            message: (error as Error).message,
          })
        ),
    },
    { label: nativeT("installedAppReload"), click: () => reloadWindow(id) },
    { type: "separator" },
    hasLauncher(entry)
      ? {
          label: nativeT("installedAppUninstallMenu"),
          click: () => void uninstallApp(id, window),
        }
      : {
          label: nativeT("installedAppDeleteMenu"),
          click: () => void deleteApp(id, window),
        },
  ];
};

const refreshMenu = (id: string): void => {
  const window = windows.get(id);
  if (!window || window.isDestroyed() || process.platform === "darwin") return;
  window.setMenu(
    Menu.buildFromTemplate([
      { label: nativeT("installedAppMenu"), submenu: menuItems(id) },
    ])
  );
};

const missingPage = (title: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>` +
      `<body style="font:15px system-ui;padding:32px">${nativeT("installedAppMissing").replace(/</g, "&lt;")}</body>`
  )}`;

/** The app windows' menus, again in the language just loaded. */
export const relabelAppWindows = (): void => {
  for (const id of windows.keys()) refreshMenu(id);
};

/** Opens (or focuses) the window of an installed app. False when unknown. */
/** Where each app's window was last; none saved: a step down from the others. */
const windowBounds = (id: string): Partial<Rectangle> => {
  try {
    const saved = JSON.parse(
      readFileSync(join(appDir(id), "window.json"), "utf8")
    ) as Rectangle;
    const area = screen.getDisplayMatching(saved).workArea;
    const onScreen =
      saved.x < area.x + area.width - 80 &&
      saved.x + saved.width > area.x + 80 &&
      saved.y >= area.y - 20 &&
      saved.y < area.y + area.height - 80;
    if (onScreen && saved.width >= 360 && saved.height >= 300) return saved;
  } catch {
    // Never opened, or the file is unreadable: the default spot.
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1040, area.width);
  const height = Math.min(760, area.height);
  const step = 32 * (windows.size % 8);
  return {
    width,
    height,
    x: area.x + Math.max(0, Math.round((area.width - width) / 2) + step - 112),
    y:
      area.y + Math.max(0, Math.round((area.height - height) / 2) + step - 112),
  };
};
const saveWindowBounds = (id: string, bounds: Rectangle): void => {
  try {
    writeFileSync(join(appDir(id), "window.json"), JSON.stringify(bounds));
  } catch {
    // Not kept: the next open uses the default spot.
  }
};

export const openInstalledAppWindow = (
  id: string,
  source: "launcher" | "chat" | "list"
): boolean => {
  const entry = readRegistry()[id];
  if (!entry) return false;
  deps.funnel("installed_app_open", source);
  const open = windows.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    return true;
  }
  try {
    updateFromSource(id);
  } catch (error) {
    console.warn("[installed-app] update failed", id, error);
  }

  const partition = `persist:artifact-app-${id}`;
  const appSession = session.fromPartition(partition);
  // No powers in v1: no permissions (camera, notifications, ...), no downloads.
  appSession.setPermissionRequestHandler((_wc, _perm, callback) =>
    callback(false)
  );
  appSession.setPermissionCheckHandler(() => false);
  appSession.on("will-download", (event) => event.preventDefault());
  handleScheme(appSession, id);

  const window = new BaseWindow({
    ...windowBounds(id),
    minWidth: 360,
    minHeight: 300,
    title: entry.title,
    icon: iconFile(appDir(id), "png") ?? undefined,
    show: false,
  });
  if (process.platform === "win32")
    window.setAppDetails({
      appId: appUserModelId(id),
      appIconPath: iconFile(appDir(id), "ico") ?? "",
    });
  windows.set(id, window);
  refreshMenu(id);
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
  // The first open: a line under the page (never in it) that its data is
  // kept on this computer, gone after a few seconds.
  let notice: WebContentsView | null = null;
  const fit = (): void => {
    // The content view's own size: on Linux the window's content bounds
    // count the menu bar, which put the line below the visible area.
    const { width, height } = window.contentView.getBounds();
    const strip = notice == null ? 0 : NOTICE_HEIGHT;
    view.setBounds({ x: 0, y: 0, width, height: height - strip });
    notice?.setBounds({ x: 0, y: height - strip, width, height: strip });
  };
  if (entry.noticeShown !== true) {
    const shown = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        javascript: false,
        partition: "artifact-app-notice",
      },
    });
    notice = shown;
    void shown.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        noticeHtml(
          `${nativeT("installedAppSavedNotice")} · ${nativeT("installedAppChangesNotice")}`
        )
      )}`
    );
    window.contentView.addChildView(shown);
    setTimeout(() => {
      if (window.isDestroyed() || notice !== shown) return;
      window.contentView.removeChildView(shown);
      shown.webContents.close();
      notice = null;
      fit();
    }, NOTICE_MS);
    entry.noticeShown = true;
    saveRegistry();
  }
  fit();
  window.on("resize", fit);
  window.on("show", fit);

  const contents = view.webContents;
  views.set(id, contents);
  servePageStore(contents);
  const origin = `${APP_SCHEME}://${id}`;
  // The app's own pages only; web links go to the user's browser, but only
  // right after a click or key press, and not more than one every 2 seconds:
  // a page cannot open tabs (with its data in the URL) on its own.
  // Pages keep the network (CDN libraries, fonts): a v1 choice.
  let lastInput = 0;
  let lastOpened = 0;
  contents.on("input-event", (_event, input) => {
    if (/^(mouseDown|keyDown|rawKeyDown|gestureTap)$/.test(input.type))
      lastInput = Date.now();
  });
  const openOutside = (url: string): void => {
    const now = Date.now();
    if (!/^https?:\/\//.test(url) || now - lastInput > 1500) return;
    if (now - lastOpened < 2000) return;
    lastOpened = now;
    void shell.openExternal(url);
  };
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(entry.title);
  });
  contents.on("context-menu", (_event, params) => {
    const edit: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
        ]
      : params.selectionText
        ? [{ role: "copy" }, { type: "separator" }]
        : [];
    Menu.buildFromTemplate([...edit, ...menuItems(id)]).popup();
  });
  contents.on("did-finish-load", () => {
    const now = readRegistry()[id];
    if (!now || now.current <= now.seen) return;
    if (now.seen > 0) deps.funnel("installed_app_edit_seen");
    now.seen = now.current;
    saveRegistry();
  });

  if (existsSync(join(versionDir(id, entry.current), entry.entry)))
    void contents.loadURL(pageUrl(entry));
  else void contents.loadURL(missingPage(entry.title));
  contents.once("did-finish-load", () => window.show());

  // Kept as it moves, not only on close: a quit can skip the close.
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;
  const keepBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!window.isDestroyed()) saveWindowBounds(id, window.getNormalBounds());
    }, 500);
  };
  window.on("move", keepBounds);
  window.on("resize", keepBounds);
  window.on("close", () => {
    clearTimeout(boundsTimer);
    saveWindowBounds(id, window.getNormalBounds());
  });
  window.on("closed", () => {
    if (!contents.isDestroyed()) contents.close();
    if (notice != null && !notice.webContents.isDestroyed())
      notice.webContents.close();
    windows.delete(id);
    views.delete(id);
    flushAllStores();
    if (windows.size === 0) deps.onAllClosed();
  });
  return true;
};
