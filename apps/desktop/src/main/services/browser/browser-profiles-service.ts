import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { app, session } from "electron";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrowserProfileInfo {
  id: string;
  browserName: string;
  browserKey: string;
  profileName: string;
  profileDir: string;
  profileDataPath: string;
  avatarIcon?: string;
}

export interface ImportProfileResult {
  success: boolean;
  partition: string;
  cookiesImported?: number;
  error?: string;
}

interface LocalStateProfileEntry {
  name?: string;
  gaia_name?: string;
  user_name?: string;
  shortcut_name?: string;
  active_time?: number;
  avatar_icon?: string;
}

interface BrowserDefinition {
  key: string;
  name: string;
  paths: Partial<Record<"darwin" | "win32" | "linux", string>>;
  executables: Partial<Record<"darwin" | "win32" | "linux", string[]>>;
}

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

// ── Browser definitions ──────────────────────────────────────────────────────

const BROWSERS: BrowserDefinition[] = [
  {
    key: "chrome",
    name: "Google Chrome",
    paths: {
      darwin: "Google/Chrome",
      win32: "Google/Chrome/User Data",
      linux: "google-chrome",
    },
    executables: {
      darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      win32: [
        "%PROGRAMFILES%/Google/Chrome/Application/chrome.exe",
        "%PROGRAMFILES(X86)%/Google/Chrome/Application/chrome.exe",
        "%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe",
      ],
      linux: ["google-chrome-stable", "google-chrome", "chrome"],
    },
  },
  {
    key: "chrome-canary",
    name: "Google Chrome Canary",
    paths: {
      darwin: "Google/Chrome Canary",
      win32: "Google/Chrome SxS/User Data",
    },
    executables: {
      darwin: [
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ],
      win32: ["%LOCALAPPDATA%/Google/Chrome SxS/Application/chrome.exe"],
    },
  },
  {
    key: "brave",
    name: "Brave",
    paths: {
      darwin: "BraveSoftware/Brave-Browser",
      win32: "BraveSoftware/Brave-Browser/User Data",
      linux: "BraveSoftware/Brave-Browser",
    },
    executables: {
      darwin: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      win32: [
        "%PROGRAMFILES%/BraveSoftware/Brave-Browser/Application/brave.exe",
        "%LOCALAPPDATA%/BraveSoftware/Brave-Browser/Application/brave.exe",
      ],
      linux: ["brave-browser", "brave"],
    },
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    paths: {
      darwin: "Microsoft Edge",
      win32: "Microsoft/Edge/User Data",
      linux: "microsoft-edge",
    },
    executables: {
      darwin: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ],
      win32: [
        "%PROGRAMFILES%/Microsoft/Edge/Application/msedge.exe",
        "%PROGRAMFILES(X86)%/Microsoft/Edge/Application/msedge.exe",
      ],
      linux: ["microsoft-edge-stable", "microsoft-edge"],
    },
  },
  {
    key: "chromium",
    name: "Chromium",
    paths: {
      darwin: "Chromium",
      win32: "Chromium/User Data",
      linux: "chromium",
    },
    executables: {
      darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      win32: ["%LOCALAPPDATA%/Chromium/Application/chrome.exe"],
      linux: ["chromium-browser", "chromium"],
    },
  },
  {
    key: "vivaldi",
    name: "Vivaldi",
    paths: {
      darwin: "Vivaldi",
      win32: "Vivaldi/User Data",
      linux: "vivaldi",
    },
    executables: {
      darwin: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      win32: ["%LOCALAPPDATA%/Vivaldi/Application/vivaldi.exe"],
      linux: ["vivaldi-stable", "vivaldi"],
    },
  },
  {
    key: "opera",
    name: "Opera",
    paths: {
      darwin: "com.operasoftware.Opera",
      win32: "Opera Software/Opera Stable",
      linux: "opera",
    },
    executables: {
      darwin: ["/Applications/Opera.app/Contents/MacOS/Opera"],
      win32: [
        "%LOCALAPPDATA%/Programs/Opera/opera.exe",
        "%PROGRAMFILES%/Opera/opera.exe",
      ],
      linux: ["opera"],
    },
  },
  {
    key: "arc",
    name: "Arc",
    paths: { darwin: "Arc/User Data" },
    executables: { darwin: ["/Applications/Arc.app/Contents/MacOS/Arc"] },
  },
  {
    key: "opera-gx",
    name: "Opera GX",
    paths: {
      darwin: "com.operasoftware.OperaGX",
      win32: "Opera Software/Opera GX Stable",
    },
    executables: {
      darwin: ["/Applications/Opera GX.app/Contents/MacOS/Opera GX"],
      win32: ["%LOCALAPPDATA%/Programs/Opera GX/opera.exe"],
    },
  },
];

// Large non-auth data, skipped when copying a profile.
const PROFILE_COPY_EXCLUDE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "Service Worker",
  "blob_storage",
  "File System",
  "GCM Store",
  "optimization_guide",
  "ShaderCache",
  "component_crx_cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
]);

const ROOT_SKIP_FILES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

const PROFILE_DIR_PATTERN = /^(Default|Profile \d+)$/;

// ── Browser data root per platform ───────────────────────────────────────────

/** Chromium's config root on Linux: $XDG_CONFIG_HOME, else ~/.config. */
export function linuxConfigRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const fromEnv = env.XDG_CONFIG_HOME;
  return fromEnv != null && path.isAbsolute(fromEnv)
    ? fromEnv
    : path.join(home, ".config");
}

function getBrowserDataRoot(browser: BrowserDefinition): string | null {
  const platform = process.platform as "darwin" | "win32" | "linux";
  const relPath = browser.paths[platform];
  if (relPath == null) return null;

  const home = os.homedir();
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", relPath);
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return path.join(localAppData, relPath);
  }
  return path.join(linuxConfigRoot(), relPath);
}

// ── Browser executable discovery ─────────────────────────────────────────────

function expandEnvVars(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? "");
}

async function findExecutableInPath(name: string): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, [name]);
    const result = stdout.trim().split("\n")[0]?.trim();
    return result && fs.existsSync(result) ? result : null;
  } catch {
    return null;
  }
}

// Browser binaries do not move mid-session.
const executableCache = new Map<string, string | null>();

async function findBrowserExecutable(
  browser: BrowserDefinition
): Promise<string | null> {
  const cached = executableCache.get(browser.key);
  if (cached !== undefined) return cached;

  const platform = process.platform as "darwin" | "win32" | "linux";
  const candidates = browser.executables[platform];
  if (candidates == null) {
    executableCache.set(browser.key, null);
    return null;
  }

  for (const candidate of candidates) {
    const expanded = expandEnvVars(candidate);
    if (path.isAbsolute(expanded)) {
      if (fs.existsSync(expanded)) {
        executableCache.set(browser.key, expanded);
        return expanded;
      }
    } else {
      const found = await findExecutableInPath(expanded);
      if (found) {
        executableCache.set(browser.key, found);
        return found;
      }
    }
  }
  executableCache.set(browser.key, null);
  return null;
}

// ── Profile discovery ────────────────────────────────────────────────────────

function readLocalState(
  browserRoot: string
): Record<string, LocalStateProfileEntry> | null {
  try {
    const raw = fs.readFileSync(path.join(browserRoot, "Local State"), "utf-8");
    const parsed = JSON.parse(raw);
    return (
      (parsed?.profile?.info_cache as Record<string, LocalStateProfileEntry>) ??
      null
    );
  } catch {
    return null;
  }
}

function readPreferencesProfileName(profilePath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(profilePath, "Preferences"), "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed?.profile?.name as string) ?? null;
  } catch {
    return null;
  }
}

function discoverProfileDirs(browserRoot: string): string[] {
  try {
    return fs
      .readdirSync(browserRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROFILE_DIR_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function resolveProfileName(
  profileDir: string,
  profileDataPath: string,
  localStateCache: Record<string, LocalStateProfileEntry> | null
): string {
  const cached = localStateCache?.[profileDir];
  if (cached?.name) return cached.name;
  if (cached?.gaia_name) return cached.gaia_name;
  if (cached?.shortcut_name) return cached.shortcut_name;
  return (
    readPreferencesProfileName(profileDataPath) ??
    (profileDir === "Default" ? "Default" : profileDir)
  );
}

// ── Profile copy ────────────────────────────────────────────────────────────
// Three tiers: a whole-directory CoW clone on macOS (`cp -c`, APFS) or Linux
// (`cp --reflink=auto`), else a parallel recursive copy with per-file
// COPYFILE_FICLONE. Caches and lockfiles are excluded, which takes a multi-GB
// profile down to the ~50-200 MB that matters for auth.

async function cloneDirectoryDarwin(
  src: string,
  dst: string
): Promise<boolean> {
  try {
    await execFileAsync("cp", ["-c", "-R", src, dst]);
    return true;
  } catch {
    return false;
  }
}

async function cloneDirectoryLinux(src: string, dst: string): Promise<boolean> {
  try {
    await execFileAsync("cp", ["--reflink=auto", "-R", src, dst]);
    return true;
  } catch {
    return false;
  }
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);

      if (entry.isDirectory()) {
        if (PROFILE_COPY_EXCLUDE_DIRS.has(entry.name)) return;
        await copyDirRecursive(srcPath, dstPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (ROOT_SKIP_FILES.has(entry.name)) return;
        try {
          await fsp.copyFile(srcPath, dstPath, fsConstants.COPYFILE_FICLONE);
        } catch {
          try {
            await fsp.copyFile(srcPath, dstPath);
          } catch {}
        }
      }
    })
  );
}

async function copyProfileDirFast(src: string, dst: string): Promise<void> {
  if (process.platform === "darwin") {
    if (await cloneDirectoryDarwin(src, dst)) return;
  }

  if (process.platform === "linux") {
    if (await cloneDirectoryLinux(src, dst)) return;
  }

  await copyDirRecursive(src, dst);
}

async function copyProfileToTemp(
  browserRoot: string,
  profileDir: string
): Promise<string> {
  const tempDir = path.join(app.getPath("temp"), `bp-import-${randomUUID()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  // Copy Local State (non-fatal if missing)
  const localStateSrc = path.join(browserRoot, "Local State");
  try {
    await fsp.copyFile(
      localStateSrc,
      path.join(tempDir, "Local State"),
      fsConstants.COPYFILE_FICLONE
    );
  } catch {
    try {
      await fsp.copyFile(localStateSrc, path.join(tempDir, "Local State"));
    } catch {}
  }

  // A CoW clone takes the whole profile and removes the excluded directories
  // afterwards; on APFS/btrfs that is metadata only and beats a per-file copy.
  const srcProfile = path.join(browserRoot, profileDir);
  const dstProfile = path.join(tempDir, profileDir);

  let usedWholeDirClone = false;

  if (process.platform === "darwin") {
    usedWholeDirClone = await cloneDirectoryDarwin(srcProfile, dstProfile);
  } else if (process.platform === "linux") {
    usedWholeDirClone = await cloneDirectoryLinux(srcProfile, dstProfile);
  }

  if (usedWholeDirClone) {
    await Promise.all(
      [...PROFILE_COPY_EXCLUDE_DIRS, ...ROOT_SKIP_FILES].map(async (name) => {
        const p = path.join(dstProfile, name);
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
      })
    );
  } else {
    await copyDirRecursive(srcProfile, dstProfile);
  }

  return tempDir;
}

// ── CDP cookie extraction ───────────────────────────────────────────────────
// The real browser binary is launched headlessly on the copied profile; only
// it can decrypt its own cookies, which DevTools then hands over.

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForDevToolsPort(
  child: ChildProcess,
  userDataDir: string,
  timeoutMs: number
): Promise<{ port: number; wsPath: string }> {
  const deadline = Date.now() + timeoutMs;
  const filePath = path.join(userDataDir, "DevToolsActivePort");

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Browser exited early with code ${child.exitCode}`);
    }

    try {
      const content = await fsp.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      const port = parseInt(lines[0] ?? "", 10);
      const wsPath = lines[1]?.trim() || "/devtools/browser";
      if (port > 0) return { port, wsPath };
    } catch {
      // File not yet written
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  throw new Error("Timeout waiting for DevToolsActivePort");
}

async function extractCookiesViaCDP(
  execPath: string,
  tempUserDataDir: string,
  profileDir: string
): Promise<CDPCookie[]> {
  const args = [
    `--user-data-dir=${tempUserDataDir}`,
    `--profile-directory=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-features=Translate",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ];

  const child = spawn(execPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });

  // Drain stderr so a chatty browser cannot fill the pipe and stall itself.
  child.stderr?.resume();

  try {
    const { port } = await waitForDevToolsPort(child, tempUserDataDir, 15_000);

    const targets = (await httpGetJson(
      `http://127.0.0.1:${port}/json`
    )) as Array<{
      id: string;
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find((t) => t.type === "page");
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target found");
    }

    const cookies = await cdpGetAllCookies(pageTarget.webSocketDebuggerUrl);
    return cookies;
  } finally {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }
}

function cdpGetAllCookies(wsUrl: string): Promise<CDPCookie[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP WebSocket timeout"));
    }, 10_000);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.enable", params: {} }));
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { cookies?: CDPCookie[] };
        };
        if (msg.id === 1) {
          ws.send(
            JSON.stringify({
              id: 2,
              method: "Network.getAllCookies",
              params: {},
            })
          );
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.result?.cookies ?? []);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onerror = (err: Event) => {
      clearTimeout(timeout);
      reject(new Error(`CDP WebSocket error: ${err}`));
    };
  });
}

// ── Partition helpers ────────────────────────────────────────────────────────

function toPartitionName(profileId: string): string {
  return `persist:bp-${profileId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

export class BrowserProfilesService {
  private cachedProfiles: BrowserProfileInfo[] | null = null;

  constructor() {
    // Stale temp dirs and partitions from earlier sessions; does not block.
    this.cleanupStaleData();
  }

  private cleanupStaleData(): void {
    const tempDir = app.getPath("temp");
    fsp
      .readdir(tempDir)
      .then((entries) => {
        for (const entry of entries) {
          if (entry.startsWith("bp-import-")) {
            fsp
              .rm(path.join(tempDir, entry), { recursive: true, force: true })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  listProfiles(): BrowserProfileInfo[] {
    if (this.cachedProfiles != null) return this.cachedProfiles;

    const results: BrowserProfileInfo[] = [];

    for (const browser of BROWSERS) {
      const root = getBrowserDataRoot(browser);
      if (root == null || !fs.existsSync(root)) continue;

      const localStateCache = readLocalState(root);
      const profileDirs = discoverProfileDirs(root);

      for (const dir of profileDirs) {
        const profileDataPath = path.join(root, dir);
        const name = resolveProfileName(dir, profileDataPath, localStateCache);
        const avatarIcon = localStateCache?.[dir]?.avatar_icon;

        results.push({
          id: `${browser.key}::${dir}`,
          browserName: browser.name,
          browserKey: browser.key,
          profileName: name,
          profileDir: dir,
          profileDataPath,
          avatarIcon: avatarIcon ?? undefined,
        });
      }
    }

    this.cachedProfiles = results;
    return results;
  }

  refreshProfiles(): BrowserProfileInfo[] {
    this.cachedProfiles = null;
    return this.listProfiles();
  }

  async importProfile(profileId: string): Promise<ImportProfileResult> {
    const profiles = this.listProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (profile == null) {
      return { success: false, partition: "", error: "Profile not found" };
    }

    const browser = BROWSERS.find((b) => b.key === profile.browserKey);
    if (browser == null) {
      return { success: false, partition: "", error: "Unknown browser" };
    }

    const partitionName = toPartitionName(profileId);
    let tempDir: string | null = null;

    try {
      // ── 1. Find browser executable (cached after first lookup) ───────
      const execPath = await findBrowserExecutable(browser);
      if (execPath == null) {
        return {
          success: false,
          partition: partitionName,
          error: `Could not find ${browser.name} executable`,
        };
      }

      const browserRoot = getBrowserDataRoot(browser);
      if (browserRoot == null) {
        return {
          success: false,
          partition: partitionName,
          error: "Could not determine browser data root",
        };
      }

      // ── 2. Copy profile (CoW clone where possible) ──────────────────
      tempDir = await copyProfileToTemp(browserRoot, profile.profileDir);

      // ── 3. Prepare partition directory in parallel with CDP start ────
      const partitionDir = path.join(
        app.getPath("userData"),
        "Partitions",
        partitionName.replace("persist:", "")
      );

      const [cdpCookies] = await Promise.all([
        // The slow part: browser startup.
        extractCookiesViaCDP(execPath, tempDir, profile.profileDir),
        (async () => {
          if (fs.existsSync(partitionDir)) {
            await fsp.rm(partitionDir, { recursive: true, force: true });
          }
          await fsp.mkdir(partitionDir, { recursive: true });

          const storageToCopy = [
            "Local Storage",
            "Session Storage",
            "IndexedDB",
          ];
          await Promise.all(
            storageToCopy.map(async (item) => {
              const src = path.join(profile.profileDataPath, item);
              if (fs.existsSync(src)) {
                await copyProfileDirFast(src, path.join(partitionDir, item));
              }
            })
          );
        })(),
      ]);

      // ── 4. Inject cookies into Electron session ─────────────────────
      const ses = session.fromPartition(partitionName);
      await ses.clearCache();

      const now = Date.now() / 1000;
      const validCookies = cdpCookies.filter(
        (c) => c.value && !(c.expires > 0 && c.expires < now)
      );

      // One Promise.all: each ses.cookies.set() is an async IPC call.
      let cookiesInjected = 0;

      const results = await Promise.allSettled(
        validCookies.map(async (cookie) => {
          const url = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}/`;
          await ses.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.session ? undefined : cookie.expires,
            sameSite: mapSameSite(cookie.sameSite),
          });
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") cookiesInjected++;
      }

      await ses.cookies.flushStore();

      this.cachedProfiles = null;
      return {
        success: true,
        partition: partitionName,
        cookiesImported: cookiesInjected,
      };
    } catch (err) {
      return {
        success: false,
        partition: partitionName,
        error:
          err instanceof Error ? err.message : "Unknown error during import",
      };
    } finally {
      if (tempDir) {
        fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async clearImportedProfile(
    profileId: string
  ): Promise<{ success: boolean; error?: string }> {
    const partitionName = toPartitionName(profileId);

    try {
      const ses = session.fromPartition(partitionName);
      await ses.clearStorageData();

      const partitionDir = path.join(
        app.getPath("userData"),
        "Partitions",
        partitionName.replace("persist:", "")
      );
      if (fs.existsSync(partitionDir)) {
        await fsp.rm(partitionDir, { recursive: true, force: true });
      }
      this.cachedProfiles = null;
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }
}

function mapSameSite(
  value?: string
): "unspecified" | "no_restriction" | "lax" | "strict" {
  switch (value?.toLowerCase()) {
    case "none":
      return "no_restriction";
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    default:
      return "unspecified";
  }
}
