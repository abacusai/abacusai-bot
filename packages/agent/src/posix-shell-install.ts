/**
 * busybox-w32: shipping it, installing it, and saying where it landed.
 *
 * Its own entry point (`@abacus-ai/agent/posix-shell`) because two processes
 * need it and only one of them is the agent. The desktop's Electron main
 * offers the same shell in the terminal panel, and main may only import leaf
 * modules of this package; the index leaves the native-addon packages
 * external and they are not inside the app's asar (see
 * src/main/agent-import-surface.test.ts). Nothing here imports pi.
 *
 * The shell the `bash` tool runs under on Windows: busybox-w32, shipped beside
 * the agent (packages/agent/vendor, fetched by scripts/download-tools.js) and
 * materialised once per user into a digest-keyed cache with a launcher per
 * applet.
 *
 * pi's own bash tool looks for Git Bash, then bash.exe on PATH, and otherwise
 * throws, so on a stock Windows install every command the model wrote failed
 * with "No bash shell found", routines included. cmd.exe or PowerShell would
 * break the POSIX habits every model has; a bundled ash keeps pipes, `&&`,
 * redirects, heredocs and the coreutils working with nothing to install.
 *
 * GPLv2: the executable is spawned as a separate process and never linked. Its
 * licence ships in THIRD-PARTY-NOTICES.txt and a NOTICE.txt sits beside the
 * installed copy.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bundledToolsDir } from "./bundled-tools.js";
import { childProcessEnv } from "./child-env.js";
import { mergePath } from "./merge-path.js";

/** Upstream release tag (frippery.org / rmyorston/busybox-w32); the digests are pinned in scripts/download-tools.js. */
export const BUSYBOX_VERSION = "FRP-6075-g169694ebd";
const BUSYBOX_HOMEPAGE = "https://frippery.org/busybox/";
const BUSYBOX_SOURCE = `https://frippery.org/files/busybox/busybox-w32-${BUSYBOX_VERSION}.tgz`;

/** The shipped file name, whichever upstream build it came from. */
export const BUSYBOX_PAYLOAD = "busybox.exe";

/**
 * The ANSI build, shipped beside the Unicode one on x64. The Unicode build
 * carries a UTF-8 code page manifest that Windows honours only from 10 1903;
 * on anything older it refuses to start ("sh.exe: UTF8 manifest not
 * supported"), so every command fails. The resolver falls back to this one.
 */
export const BUSYBOX_ANSI_PAYLOAD = "busybox-ansi.exe";

/** Names the payload outright; the desktop sets it because an agent from an installed experience runs away from `vendor/`. */
export const POSIX_SHELL_PAYLOAD_ENV = "ABACUSAI_BOT_POSIX_SHELL_PAYLOAD";

/** Records what an install produced, so a later start can tell it is intact. */
const MANIFEST = "install.json";
const MANIFEST_VERSION = 1;

/** Where the shell lives once materialised. */
export interface PosixShell {
  /** The `sh` launcher; spawned as `sh.exe -c <command>`. */
  readonly sh: string;
  /** Direct payloads need the applet name before shell flags. */
  readonly args?: readonly string[];
  /** Applet launchers, put at the front of the child's PATH and nowhere else. */
  readonly bin: string;
  /** `BB_OVERRIDE_APPLETS` for the child: an installed tool wins over the applet. */
  readonly overrideApplets: string;
  /** The ANSI build: arguments outside the system code page arrive mangled. */
  readonly ansi?: boolean;
}

/**
 * Applets that get a launcher in the private bin directory, so a native child
 * program (a node script spawning `grep`) finds them too; inside ash they are
 * builtins regardless.
 */
export const BUSYBOX_LINKED_APPLETS: readonly string[] = [
  "arch",
  "ascii",
  "awk",
  "base32",
  "base64",
  "basename",
  "cat",
  "chmod",
  "cksum",
  "clear",
  "cmp",
  "comm",
  "cp",
  "cut",
  "dirname",
  "dos2unix",
  "du",
  "df",
  "echo",
  "env",
  "egrep",
  "expr",
  "false",
  "fgrep",
  "find",
  "flock",
  "fold",
  "getopt",
  "grep",
  "groups",
  "hd",
  "head",
  "hexdump",
  "iconv",
  "ipcalc",
  "join",
  "link",
  "ln",
  "logname",
  "ls",
  "md5sum",
  "mkdir",
  "mktemp",
  "mv",
  "nl",
  "nproc",
  "od",
  "paste",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rev",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sh",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "sleep",
  "sort",
  "split",
  "stat",
  "strings",
  "sum",
  "sync",
  "tac",
  "tail",
  "tee",
  "test",
  "timeout",
  "touch",
  "tr",
  "true",
  "truncate",
  "tsort",
  "uname",
  "unexpand",
  "uniq",
  "unix2dos",
  "unlink",
  "uudecode",
  "uuencode",
  "wc",
  "which",
  "whoami",
  "xargs",
  "xxd",
  "yes",
];

/**
 * Applets an installed tool should win over. Not `find`, `sort` or `timeout`:
 * Windows has commands of those names with different semantics, and the model
 * means the POSIX ones.
 */
export const BUSYBOX_PREFER_EXTERNAL: readonly string[] = [
  "ar",
  "bc",
  "bunzip2",
  "bzcat",
  "bzip2",
  "cpio",
  "crond",
  "crontab",
  "dc",
  "dd",
  "diff",
  "dpkg",
  "dpkg-deb",
  "ed",
  "ftpget",
  "ftpput",
  "gunzip",
  "gzip",
  "httpd",
  "kill",
  "killall",
  "less",
  "lzma",
  "lzop",
  "make",
  "man",
  "nc",
  "patch",
  "pdpmake",
  "pgrep",
  "pidof",
  "pkill",
  "ps",
  "rpm",
  "rpm2cpio",
  "shred",
  "shuf",
  "ssl_client",
  "stty",
  "su",
  "tar",
  "unlzma",
  "unlzop",
  "unxz",
  "unzip",
  "uptime",
  "vi",
  "watch",
  "wget",
  "whois",
  "xz",
  "xzcat",
  "zcat",
];

/** The `BB_OVERRIDE_APPLETS` value: a leading `;` falls back to the applet when nothing external exists. */
export function busyboxOverrideApplets(): string {
  return `;${BUSYBOX_PREFER_EXTERNAL.join(",")}`;
}

const NOTICE_TEXT = [
  "busybox.exe here is an unmodified copy of busybox-w32, spawned by AbacusAI Bot",
  "as a separate process and licensed under the GNU General Public License,",
  "version 2. The full licence text is in the app's THIRD-PARTY-NOTICES.txt.",
  "",
  `Version: ${BUSYBOX_VERSION}`,
  `Project: ${BUSYBOX_HOMEPAGE}`,
  `Source:  ${BUSYBOX_SOURCE}`,
  "",
].join("\n");

export interface InstallOptions {
  platform?: NodeJS.Platform;
  /** Overrides payload discovery; the tests use it, so does the env variable. */
  payload?: string;
  /** The payload is the ANSI build. */
  ansi?: boolean;
  /** Overrides the cache root. */
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function exists(file: string): boolean {
  try {
    return statSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // Unreadable, or a parent that is not a directory: not a file we can use,
    // and it must not throw past the fallback.
    return false;
  }
}

/** The payload: named by the desktop, else beside the agent under `vendor/`. */
export function findPayload(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const explicit = (env[POSIX_SHELL_PAYLOAD_ENV] ?? "").trim();
  if (explicit.length > 0 && exists(explicit)) return explicit;

  const shipped = path.join(bundledToolsDir(), BUSYBOX_PAYLOAD);

  return exists(shipped) ? shipped : undefined;
}

/**
 * Per-user, on the local disk: LOCALAPPDATA rather than a roaming profile that
 * may sit on a share without hard links, and never the workspace.
 */
function defaultCacheRoot(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA;
  if (local != null && local.length > 0)
    return path.join(local, "abacusai-bot", "posix-shell");

  return path.join(os.homedir(), ".abacusai-bot", "posix-shell");
}

/**
 * Launchers as hard links to the one executable: busybox dispatches on argv[0],
 * and a link needs no symlink privilege. A filesystem without hard links gets
 * copies, so a native child can still spawn `grep.exe` through PATH.
 */
function installApplets(binDir: string, exe: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const applet of BUSYBOX_LINKED_APPLETS) {
    const link = path.join(binDir, `${applet}.exe`);
    try {
      linkSync(exe, link);
    } catch {
      copyFileSync(exe, link);
    }
  }
}

function installPayload(
  payload: string,
  digest: string,
  cacheDir: string
): void {
  const staging = `${cacheDir}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(staging, { recursive: true });
  try {
    const exe = path.join(staging, BUSYBOX_PAYLOAD);
    writeFileSync(exe, readFileSync(payload));
    if (sha256File(exe) !== digest)
      throw new Error("payload copy does not match its digest");
    installApplets(path.join(staging, "bin"), exe);
    writeFileSync(path.join(staging, "NOTICE.txt"), NOTICE_TEXT, "utf8");
    writeFileSync(
      path.join(staging, MANIFEST),
      JSON.stringify({ digest, version: MANIFEST_VERSION }),
      "utf8"
    );
    publish(staging, cacheDir, digest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Publish atomically, accepting a concurrent install that verifies. A cached
 * directory that does not verify is moved aside rather than deleted in place,
 * so a shell still running from it keeps its handles.
 */
function publish(staging: string, cacheDir: string, digest: string): void {
  try {
    renameSync(staging, cacheDir);
    return;
  } catch (error) {
    if (isInstalled(cacheDir, digest)) return;
    const retired = `${cacheDir}.stale.${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(cacheDir, retired);
    } catch {
      // Locked by a running shell; nothing safe is left to do.
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    try {
      renameSync(staging, cacheDir);
    } catch (second) {
      if (!isInstalled(cacheDir, digest)) throw second;
    }
  }
}

/** The executable, every launcher and the notice, verified before reuse. A matching entry count alone proves nothing. */
function isInstalled(cacheDir: string, digest: string): boolean {
  const exe = path.join(cacheDir, BUSYBOX_PAYLOAD);
  if (!exists(exe)) return false;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(cacheDir, MANIFEST), "utf8")
    );
    if (typeof manifest !== "object" || manifest === null) return false;
    if (!("digest" in manifest) || manifest.digest !== digest) return false;
    if (!("version" in manifest) || manifest.version !== MANIFEST_VERSION)
      return false;
    if (sha256File(exe) !== digest) return false;
    const binary = statSync(exe);
    const bin = path.join(cacheDir, "bin");
    if (readdirSync(bin).length !== BUSYBOX_LINKED_APPLETS.length) return false;
    for (const applet of BUSYBOX_LINKED_APPLETS) {
      const info = statSync(path.join(bin, `${applet}.exe`));
      if (!info.isFile() || info.size !== binary.size) return false;
      // A hard link shares the verified file; a copy needs its own digest.
      const linked =
        info.ino !== 0 && info.ino === binary.ino && info.dev === binary.dev;
      if (!linked && sha256File(path.join(bin, `${applet}.exe`)) !== digest)
        return false;
    }

    return statSync(path.join(cacheDir, "NOTICE.txt")).size > 0;
  } catch {
    return false;
  }
}

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[posix-shell] ${message}\n`);
}

/** The un-memoised half: install (or verify) the shell and say where it is, or undefined with one warning. */
export function installPosixShell(
  options: InstallOptions = {}
): PosixShell | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = options.env ?? process.env;

  const payload = options.payload ?? findPayload(env);
  const ansi = options.ansi === true ? { ansi: true } : {};
  try {
    if (payload == null) {
      warnOnce("no bundled busybox; bash needs Git Bash or bash.exe on PATH");
      return undefined;
    }
    const digest = sha256File(payload);
    const root = options.cacheRoot ?? defaultCacheRoot(env);
    const cacheDir = path.join(
      root,
      `${BUSYBOX_VERSION}-${digest.slice(0, 16)}`
    );
    mkdirSync(root, { recursive: true });
    if (!isInstalled(cacheDir, digest))
      installPayload(payload, digest, cacheDir);
    if (!isInstalled(cacheDir, digest))
      throw new Error(`install did not verify: ${cacheDir}`);

    return {
      sh: path.join(cacheDir, "bin", "sh.exe"),
      bin: path.join(cacheDir, "bin"),
      overrideApplets: busyboxOverrideApplets(),
      ...ansi,
    };
  } catch (error) {
    warnOnce(`could not install the bundled shell: ${String(error)}`);
    // A cache can be locked or unwritable while the shipped executable is
    // still runnable. BusyBox dispatches by argv[1] when invoked directly.
    return payload != null && exists(payload)
      ? {
          sh: payload,
          args: ["sh"],
          bin: path.dirname(payload),
          overrideApplets: busyboxOverrideApplets(),
          ...ansi,
        }
      : undefined;
  }
}

/** Failure text from a shell that cannot run `printf ok`, or undefined when it can. */
export type ShellSelfTest = (
  shell: PosixShell,
  env: NodeJS.ProcessEnv
) => string | undefined;

/** Generous: the first start of a freshly written executable can wait on the virus scanner. */
const SELF_TEST_TIMEOUT_MS = 20_000;

/** Run the shell exactly as a command would, with the environment commands get. */
export const selfTestPosixShell: ShellSelfTest = (shell, env) => {
  const probe = spawnSync(
    shell.sh,
    [...(shell.args ?? []), "-c", "printf ok"],
    {
      env: posixShellEnv(env, shell),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SELF_TEST_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  if (probe.error == null && probe.status === 0 && probe.stdout === "ok")
    return undefined;
  // Slow is not broken: a scanner holding a fresh executable can outlast the
  // probe, and falling back would pin the ANSI build for the whole process.
  // A build that cannot run fails at once.
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    return undefined;

  return (
    probe.error?.message ??
    (probe.stderr.trim() || `exit ${String(probe.status ?? probe.signal)}`)
  );
};

export interface ResolveOptions extends Omit<InstallOptions, "ansi"> {
  /** Overrides the probe; the tests use it. */
  selfTest?: ShellSelfTest;
}

/** A key's `Path` value, unexpanded, or undefined. */
export type RegistryRead = (key: string) => string | undefined;

const ENVIRONMENT_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
];

/**
 * The `Path` value in a `reg export` file: `"Path"="..."` for REG_SZ, or
 * `"Path"=hex(2):..` (UTF-16LE bytes, wrapped with `\`) for REG_EXPAND_SZ.
 */
export function parseRegExportPath(text: string): string | undefined {
  const joined = text.replace(/^\uFEFF/, "").replace(/\\\r?\n\s*/g, "");
  const line = /^"Path"=(.*)$/im.exec(joined)?.[1]?.trim();
  if (line == null) return undefined;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(line);
  if (quoted != null) return quoted[1]!.replace(/\\(.)/g, "$1");
  const hex = /^hex\((?:2|1)\):([0-9a-f,]*)$/i.exec(line);
  if (hex == null) return undefined;
  const bytes = Buffer.from(
    hex[1]!
      .split(",")
      .filter((byte) => byte.length > 0)
      .map((byte) => Number.parseInt(byte, 16))
  );

  return bytes.toString("utf16le").replace(/\0+$/, "");
}

/**
 * Through `reg export`, which writes UTF-16: `reg query` prints in the console
 * code page, which mangles a non-ASCII user folder.
 */
function readRegistryPath(key: string): string | undefined {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const dir = mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-env-"));
  try {
    const file = path.join(dir, "env.reg");
    const exported = spawnSync(
      path.join(root, "System32", "reg.exe"),
      ["export", key, file, "/y"],
      { stdio: "ignore", timeout: 5_000, windowsHide: true }
    );
    if (exported.error != null || exported.status !== 0) return undefined;

    return parseRegExportPath(readFileSync(file).toString("utf16le"));
  } catch {
    // An unreadable key or temp dir: this process's own PATH stands.
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `%NAME%` from `env`, any case; an unknown name stays as written. */
function expandVariables(text: string, env: NodeJS.ProcessEnv): string {
  const values = new Map(
    Object.entries(env).map(([key, value]) => [key.toUpperCase(), value])
  );

  return text.replace(
    /%([^%]+)%/g,
    (whole, name: string) => values.get(name.toUpperCase()) ?? whole
  );
}

const REGISTRY_TTL_MS = 30_000;
const registryCache = new Map<
  string,
  { at: number; value: string | undefined }
>();

/** Read at most every 30 s: commands spawn often, installers run rarely. */
function cachedRegistryPath(key: string): string | undefined {
  const hit = registryCache.get(key);
  if (hit != null && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.value;
  const value = readRegistryPath(key);
  registryCache.set(key, { at: Date.now(), value });

  return value;
}

/** A PATH entry as compared: case folded, trailing separators dropped. */
function pathKey(entry: string): string {
  let end = entry.length;
  while (end > 0 && (entry[end - 1] === "\\" || entry[end - 1] === "/")) end--;

  return entry.slice(0, end).toLowerCase();
}

/**
 * The machine then the user PATH as the registry holds them now, less what
 * this process's PATH already has. A desktop app started before an installer
 * ran keeps the PATH it started with, so `node` is "not found" until a restart.
 */
export function registryPathEntries(
  env: NodeJS.ProcessEnv,
  read: RegistryRead = cachedRegistryPath
): string | undefined {
  const current = new Set(
    (childProcessEnv(env).PATH ?? "").split(";").map(pathKey)
  );
  const fresh = ENVIRONMENT_KEYS.flatMap((key) =>
    expandVariables(read(key) ?? "", env).split(";")
  ).filter((entry) => entry.length > 0 && !current.has(pathKey(entry)));

  return mergePath(fresh.join(";"), undefined, ";");
}

/** The builds to try, best first: the named payload, then the ANSI build beside it. */
function candidates(
  payload: string
): readonly { payload: string; ansi: boolean }[] {
  const fallback = path.join(path.dirname(payload), BUSYBOX_ANSI_PAYLOAD);

  return [
    { payload, ansi: path.basename(payload) === BUSYBOX_ANSI_PAYLOAD },
    ...(fallback !== payload && exists(fallback)
      ? [{ payload: fallback, ansi: true }]
      : []),
  ];
}

const reported = new Set<string>();

function reportOnce(message: string): void {
  if (reported.has(message)) return;
  reported.add(message);
  process.stderr.write(`[posix-shell] ${message}\n`);
}

/**
 * The one place a Windows shell is chosen: each bundled build is installed and
 * must run `printf ok` before it is used, the Unicode build first. Undefined
 * when none runs, which leaves every caller on its no-bundled-shell path (pi's
 * Git Bash lookup for the tool, cmd.exe for the rest) and the model without
 * the busybox guidance.
 */
export function resolvePosixShell(
  options: ResolveOptions = {}
): PosixShell | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = options.env ?? process.env;
  const selfTest = options.selfTest ?? selfTestPosixShell;

  const payload = options.payload ?? findPayload(env);
  if (payload == null) return installPosixShell(options);

  for (const candidate of candidates(payload)) {
    const shell = installPosixShell({ ...options, ...candidate });
    if (shell == null) continue;
    const failure = selfTest(shell, env);
    if (failure == null) return shell;
    reportOnce(
      `${path.basename(candidate.payload)} failed its self-test: ${failure}`
    );
  }
  reportOnce("no bundled shell runs on this machine");

  return undefined;
}

let resolved: PosixShell | undefined | null = null;
let retryAt = 0;
const RETRY_MS = 30_000;
/** The last launcher this process handed out, named if it is lost for good. */
let handedOut: string | undefined;

/**
 * The resolved shell, memoised but re-verified on every call: a launcher
 * removed after its self-test (antivirus software can quarantine busybox) is
 * reinstalled at once rather than handed out missing for the rest of the
 * process. Failed installs are rechecked after a short delay. The
 * options are the tests'.
 */
export function posixShell(
  options: ResolveOptions = {}
): PosixShell | undefined {
  if (resolved != null && !exists(resolved.sh)) {
    reportOnce(
      `${resolved.sh} disappeared after it was installed; reinstalling`
    );
    resolved = null;
  }
  if (
    resolved === null ||
    ((resolved === undefined || resolved.args != null) && Date.now() >= retryAt)
  ) {
    resolved = resolvePosixShell(options);
    retryAt = Date.now() + RETRY_MS;
  }
  if (resolved != null) handedOut = resolved.sh;

  return resolved;
}

/**
 * posixShell() for a command about to spawn under it. Once a shell has been
 * handed out, losing it is an error the model sees, never a silent switch to
 * another shell; undefined only where there never was one.
 */
export function commandPosixShell(
  options: ResolveOptions = {}
): PosixShell | undefined {
  const shell = posixShell(options);
  if (shell == null && handedOut != null)
    throw new Error(
      `The bundled shell ${handedOut} was removed and could not be reinstalled; antivirus software may be quarantining it. Allow the app's posix-shell folder in it, then run the command again.`
    );

  return shell;
}

/** Test seam: forget the memoised answer. */
export function resetPosixShellForTesting(): void {
  resolved = null;
  retryAt = 0;
  handedOut = undefined;
  warned = false;
  reported.clear();
  registryCache.clear();
}

/**
 * TMPDIR, TMP and TEMP for any of them missing (in any case), all naming one
 * temp dir: Windows sets only TMP and TEMP, and there is no /tmp.
 */
function tempDirEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = (name: string): string | undefined =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const dir =
    [value("TEMP"), value("TMP"), value("TMPDIR")].find(
      (candidate) => candidate != null && candidate.length > 0
    ) ?? os.tmpdir();

  return Object.fromEntries(
    ["TMPDIR", "TMP", "TEMP"]
      .filter((name) => value(name) == null)
      .map((name) => [name, dir])
  );
}

/**
 * `env` for a child of the shell: the launchers first on PATH, the registry's
 * PATH entries this process lacks last, the override list, and a temp dir
 * where one is missing. Nothing else changes.
 */
export function posixShellEnv(
  env: NodeJS.ProcessEnv,
  shell: PosixShell,
  /** PATH entries installed since the app started; read on Windows only. */
  registryPath: string | undefined = process.platform === "win32"
    ? registryPathEntries(env)
    : undefined
): Record<string, string> {
  const base = childProcessEnv(env);

  return childProcessEnv(base, tempDirEnv(base), {
    PATH: mergePath(shell.bin, mergePath(base.PATH, registryPath)) ?? shell.bin,
    BB_OVERRIDE_APPLETS: shell.overrideApplets,
  });
}
