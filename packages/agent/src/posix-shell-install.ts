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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
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
import { mergePath } from "./merge-path.js";

/** Upstream release tag (frippery.org / rmyorston/busybox-w32); the digests are pinned in scripts/download-tools.js. */
export const BUSYBOX_VERSION = "FRP-6075-g169694ebd";
const BUSYBOX_HOMEPAGE = "https://frippery.org/busybox/";
const BUSYBOX_SOURCE = `https://frippery.org/files/busybox/busybox-w32-${BUSYBOX_VERSION}.tgz`;

/** The shipped file name, whichever upstream build it came from. */
export const BUSYBOX_PAYLOAD = "busybox.exe";

/** Names the payload outright; the desktop sets it because an agent from an installed experience runs away from `vendor/`. */
export const POSIX_SHELL_PAYLOAD_ENV = "ABACUSAI_BOT_POSIX_SHELL_PAYLOAD";

/** Records what an install produced, so a later start can tell it is intact. */
const MANIFEST = "install.json";
const MANIFEST_VERSION = 1;

/** Where the shell lives once materialised. */
export interface PosixShell {
  /** The `sh` launcher; spawned as `sh.exe -c <command>`. */
  readonly sh: string;
  /** Applet launchers, put at the front of the child's PATH and nowhere else. */
  readonly bin: string;
  /** `BB_OVERRIDE_APPLETS` for the child: an installed tool wins over the applet. */
  readonly overrideApplets: string;
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

  try {
    const payload = options.payload ?? findPayload(env);
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
    };
  } catch (error) {
    warnOnce(`could not install the bundled shell: ${String(error)}`);
    return undefined;
  }
}

let resolved: PosixShell | undefined | null = null;

/** The bundled shell, installed once per process; undefined off Windows or without a payload. */
export function posixShell(): PosixShell | undefined {
  if (resolved === null) resolved = installPosixShell();

  return resolved;
}

/** Test seam: forget the memoised answer. */
export function resetPosixShellForTesting(): void {
  resolved = null;
  warned = false;
}

/**
 * `env` for a child of the shell: the launchers first on PATH, under the key
 * the environment already spells it with (Windows says `Path`), and the
 * override list. Nothing else changes.
 */
export function posixShellEnv(
  env: NodeJS.ProcessEnv,
  shell: PosixShell
): NodeJS.ProcessEnv {
  const key = env.PATH == null && env.Path != null ? "Path" : "PATH";

  return {
    ...env,
    [key]: mergePath(shell.bin, env.PATH ?? env.Path) ?? shell.bin,
    BB_OVERRIDE_APPLETS: shell.overrideApplets,
  };
}
