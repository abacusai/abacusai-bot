/**
 * What the agent deletes goes to the Recycle Bin / Trash, and the agent
 * never empties it.
 *
 * One mover takes every delete: the desktop's `shell.trashItem`, asked over
 * the host channel (setTrashMover). The file tools call it directly; shell
 * commands reach it through launchers put first on their PATH
 * (trash-shim.ts), which ask this process over a local socket. A socket
 * token carries what the command may write, so a confined command cannot
 * have this process move what its sandbox would not let it delete.
 *
 * Emptying the trash is refused before a command starts (emptiesTrash), and
 * again by the launchers on the paths the shell actually expanded.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { childProcessEnv } from "./child-env.js";
import {
  execAsNode,
  launcherDir,
  selfNode,
  shellQuote,
  writeLauncher,
} from "./launchers.js";
import { mergePath } from "./merge-path.js";
import { modelPath } from "./model-path.js";
import { posixShell } from "./posix-shell-install.js";
import {
  emptyTrashMessage,
  mayDeleteForGood,
  TRASH_APPLETS,
  TRASH_ENV,
  TRASH_SHIMMED,
  TRASH_UNAVAILABLE,
  trashName,
} from "./trash-shim.js";

export { emptyTrashMessage } from "./trash-shim.js";

/** Moves one path to the platform's trash, or throws why it could not. */
export type TrashMover = (file: string) => Promise<void>;

let mover: TrashMover | null = null;

/** Registered by the session that owns the host channel; null where there is none. */
export function setTrashMover(next: TrashMover | null): void {
  mover = next;
}

/** A big folder can take the shell a while to move. */
export const TRASH_TIMEOUT_MS = 10 * 60_000;

/** Moves `file` to the trash: null when it went, otherwise why not. */
export async function moveToTrash(file: string): Promise<string | null> {
  if (mover == null) return TRASH_UNAVAILABLE.session;
  try {
    await mover(file);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A file tool's delete: to the trash, or deleted for good when the trash will
 * not take it and that may go for good (mayDeleteForGood); otherwise left in
 * place. Null when it went to the trash, otherwise the note the tool's result
 * carries.
 */
export async function removeToTrash(file: string): Promise<string | null> {
  const reason = await moveToTrash(file);
  if (reason == null) return null;
  if (!mayDeleteForGood(file, reason))
    return `Could not move ${modelPath(file)} to the ${trashName()} (${reason}); left it in place, as it may be open in another program.`;
  await fsp.rm(file, { recursive: true, force: true });

  return `Could not move ${modelPath(file)} to the ${trashName()} (${reason}); deleted it permanently instead.`;
}

/** What one command's token lets it move: anywhere (null), or under these roots. */
export interface TrashScope {
  roots: readonly string[] | null;
}

const MAX_TOKENS = 1024;
const scopes = new Map<string, TrashScope>();

function issueToken(scope: TrashScope): string {
  const token = randomBytes(16).toString("hex");
  scopes.set(token, scope);
  // Oldest first; a background job's token outlives its command, not the session.
  while (scopes.size > MAX_TOKENS) scopes.delete(scopes.keys().next().value!);

  return token;
}

const foldCase = process.platform === "win32" || process.platform === "darwin";

function inside(child: string, root: string): boolean {
  const rel = path.relative(
    foldCase ? root.toLowerCase() : root,
    foldCase ? child.toLowerCase() : child
  );

  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The path as the kernel sees it, its last component left as is (a link is moved, not followed). */
function canonicalParent(file: string): string {
  try {
    return path.join(
      fs.realpathSync.native(path.dirname(file)),
      path.basename(file)
    );
  } catch {
    return file;
  }
}

/** Why `file` may not be moved for this token, or null. */
export function outsideScope(token: string, file: string): string | null {
  const scope = scopes.get(token);
  if (scope == null) return "an unknown token";
  if (!path.isAbsolute(file)) return "not an absolute path";
  if (scope.roots == null) return null;
  const real = canonicalParent(file);

  return scope.roots.some((root) => inside(real, root))
    ? null
    : "outside what the sandbox lets this command change";
}

interface TrashServer {
  address: string;
  server: net.Server;
}

let service: TrashServer | null = null;

async function answer(line: string): Promise<string> {
  let request: { token?: unknown; paths?: unknown };
  try {
    request = JSON.parse(line) as typeof request;
  } catch {
    return JSON.stringify({ results: [] });
  }
  const token = typeof request.token === "string" ? request.token : "";
  const paths = Array.isArray(request.paths) ? request.paths : [];
  const results: Array<string | null> = [];
  for (const file of paths) {
    if (typeof file !== "string") {
      results.push("not a path");
      continue;
    }
    results.push(outsideScope(token, file) ?? (await moveToTrash(file)));
  }

  return JSON.stringify({ results });
}

/** The socket the launchers ask, started on first use and closed with the process. */
export function trashSocket(): string {
  if (service != null) return service.address;
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  let address: string;
  if (process.platform === "win32") {
    address = `\\\\.\\pipe\\abacusai-bot-trash-${suffix}`;
  } else {
    // A private directory: the socket is only for this user's commands.
    // Real path: macOS's sandbox matches the socket by it.
    const dir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-trash-"))
    );
    address = path.join(dir, "s");
    process.once("exit", () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      void answer(line).then((reply) => socket.end(`${reply}\n`));
    });
  });
  server.on("error", (error) => {
    process.stderr.write(`[trash] ${String(error)}\n`);
  });
  server.listen(address);
  // Never the reason the agent stays up.
  server.unref();
  service = { address, server };

  return address;
}

/** The launcher this file's build sits beside: the bundle's `.js`, or the source in tests. */
function shimEntry(): string | null {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["trash-shim.js", "trash-shim.ts"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/** One launcher: `#!/bin/sh`, which busybox runs too. `find` and `git` skip Node unless they delete. */
export function launcherScript(
  name: string,
  node: string,
  entry: string,
  dir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const flags = entry.endsWith(".ts") ? ["--no-warnings"] : [];
  const run = execAsNode(node, [...flags, shellQuote(entry), name]);
  const separator = platform === "win32" ? ";" : ":";
  const fast: Record<string, string> = {
    find: "-delete) deletes=1 ;;",
    git: "clean) deletes=1 ;;",
  };
  if (fast[name] == null) return `#!/bin/sh\n${run}\n`;
  // The real one, found past this directory with PATH left as it is, so what
  // it runs (find -exec rm) still finds the launchers. Windows' find is the
  // busybox applet.
  const exe = platform === "win32" ? `${name}.exe` : name;
  const real =
    platform === "win32" && name === "find"
      ? `[ -n "$${TRASH_ENV.applets}" ] && exec "$${TRASH_ENV.applets}/find.exe" "$@"`
      : [
          `set -f; saved=$IFS; IFS='${separator}'`,
          "for dir in $PATH; do",
          `  [ "$dir" = ${shellQuote(dir)} ] && continue`,
          `  if [ -f "$dir/${exe}" ] && [ -x "$dir/${exe}" ]; then IFS=$saved; set +f; exec "$dir/${exe}" "$@"; fi`,
          "done",
          "IFS=$saved; set +f",
        ].join("\n");

  return [
    "#!/bin/sh",
    "deletes=",
    'for arg in "$@"; do',
    `  case "$arg" in ${fast[name]} esac`,
    "done",
    `if [ -z "$deletes" ]; then`,
    `  ${real.split("\n").join("\n  ")}`,
    "fi",
    run,
    "",
  ].join("\n");
}

let launchers: string | null | undefined;

/**
 * The launcher directory, written once per runtime and build under the app
 * home. Null when it cannot be (no build of the launcher, an unwritable home):
 * commands then run as before rather than not at all.
 */
export function trashLaunchers(): string | null {
  if (launchers !== undefined) return launchers;
  const entry = shimEntry();
  if (entry == null) return (launchers = null);
  const node = selfNode();
  const dir = launcherDir(
    "trash-shim",
    node,
    entry,
    fs.readFileSync(entry, "utf8")
  );
  const script = entry.replaceAll("\\", "/");
  try {
    for (const name of TRASH_SHIMMED)
      writeLauncher(
        path.join(dir, name),
        launcherScript(name, node, script, dir)
      );
    launchers = dir;
  } catch (error) {
    process.stderr.write(`[trash] launchers not written: ${String(error)}\n`);
    launchers = null;
  }

  return launchers;
}

/** Test seam: forget the launchers and the socket. */
export function resetTrashForTesting(): void {
  launchers = undefined;
  service?.server.close();
  service = null;
  scopes.clear();
  mover = null;
}

/** `BB_OVERRIDE_APPLETS` with busybox's own rm and find giving way to what PATH finds first. */
function overrideApplets(current: string | undefined): string {
  const value = current ?? "";
  const separator = value.includes(";") ? "," : ";";
  const missing = TRASH_APPLETS.filter(
    (name) => !value.split(/[;,\s]/).includes(name)
  );

  return missing.length === 0
    ? value
    : `${value}${separator}${missing.join(",")}`;
}

/**
 * A command's environment with the launchers first on PATH and a token for
 * `scope` (null roots: anywhere). Unchanged when the launchers could not be
 * written. The scope is held by reference, so a caller can widen it once it
 * knows the command runs unconfined.
 */
export function trashShimEnv(
  env: NodeJS.ProcessEnv,
  scope: TrashScope = { roots: null }
): Record<string, string> {
  const base = childProcessEnv(env);
  const dir = trashLaunchers();
  if (dir == null) return base;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const applets = process.platform === "win32" ? posixShell()?.bin : undefined;
  const entry = shimEntry()!.replaceAll("\\", "/");

  return childProcessEnv(base, {
    PATH: mergePath(dir, base.PATH, delimiter) ?? dir,
    [TRASH_ENV.socket]: trashSocket(),
    [TRASH_ENV.token]: issueToken(scope),
    [TRASH_ENV.shims]: dir,
    [TRASH_ENV.node]: selfNode(),
    [TRASH_ENV.entry]: entry,
    ...(applets != null
      ? {
          [TRASH_ENV.applets]: applets.replaceAll("\\", "/"),
          BB_OVERRIDE_APPLETS: overrideApplets(base.BB_OVERRIDE_APPLETS),
        }
      : {}),
  });
}

/** Normalized for matching: quotes, escapes and case gone, slashes forward. */
function normalize(text: string): string {
  return text
    .replace(/["'`^]/g, "")
    .replace(/\\(?=\$)/g, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** A trash location in a command's text, however it reaches it ($HOME, %USERPROFILE%, ~, a drive). */
const TRASH_PLACE =
  /\$recycle\.bin|(?:^|[\s/~:=(])recycler(?:\/|\s|$)|(?:^|[\s/~:=(])\.trash(?:es|-\d+)?(?=$|[\s/;&|),*])|\/share\/trash(?=$|[\s/;&|),*])|xdg_data_home\S*\/trash\b|\btrash:\/\/|shell:recyclebinfolder|645ff040-5081-101b-9f08-00aa002f954e|namespace\(\s*(?:10|0x0*a)\s*\)/;

/** Ways to delete, in shells, PowerShell, cmd and scripting languages. */
const DELETES =
  /(?:^|[\s;&|(`{$!])(?:rm|rmdir|unlink|del|erase|rd|ri|remove-item|clear-item|rimraf|shred|trash-rm)(?=$|[\s;&|)/])|-delete\b|\brmtree\b|\bos\.(?:remove|unlink|rmdir|removedirs)\b|\b(?:unlink|rm|rmdir)(?:sync)?\s*\(|\.unlink\s*\(|\.delete(?:file|directory)?\s*\(|\bdelete(?:file|directory)\b|\binvokeverb(?:ex)?\b|\bverbs\s*\(|\bgit\s+clean\b|\bgio\s+remove\b|::delete\s*\(/;

/** Forms that empty a trash outright, wherever they point. */
const EMPTIES: readonly RegExp[] = [
  /\bclear-recyclebin\b/,
  /\bshemptyrecyclebin\b/,
  /\btrash-empty\b/,
  /\b(?:gio|gvfs-trash)\b[^\n;&|]*--empty\b/,
  /\bktrash\d*\b[^\n;&|]*--empty\b/,
  /\bkioclient\d*\b[^\n;&|]*\bemptytrash\b/,
  /\b(?:osascript|finder)\b[\s\S]*\bempty(?:\s+the)?\s+trash\b/,
  /\b(?:osascript|finder)\b[\s\S]*\bto\s+empty\b/,
  /\bapplication\s*\(\s*finder\s*\)\s*\.empty\s*\(/,
  /\brecycle_?bin\s*\(\s*\)\s*\.empty\s*\(/,
  /\bwinshell\b[\s\S]*\.empty\s*\(/,
];

/** Whether a command (or a script it names) would empty or delete from the trash. */
function textEmptiesTrash(text: string): boolean {
  const normalized = normalize(text);
  if (EMPTIES.some((pattern) => pattern.test(normalized))) return true;

  return TRASH_PLACE.test(normalized) && DELETES.test(normalized);
}

/** Script files a command runs, which may be where the delete is written. */
const SCRIPT_FILE =
  /[^\s"'<>|;&()]+\.(?:ps1|psm1|sh|bash|zsh|command|py|js|cjs|mjs|ts|rb|pl|bat|cmd|vbs|applescript)\b/gi;

const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Whether `command` would empty the Recycle Bin / Trash or delete from it,
 * judged on its text and the scripts it names. The launchers judge the paths
 * a variable or glob turned into; this catches what never reaches them
 * (Clear-RecycleBin, a Finder script, a Python one-liner).
 */
export function emptiesTrash(command: string, cwd: string): boolean {
  if (textEmptiesTrash(command)) return true;
  for (const match of command.matchAll(SCRIPT_FILE)) {
    const file = path.resolve(
      cwd,
      match[0].replace(/^~(?=[\\/])/, os.homedir())
    );
    try {
      const info = fs.statSync(file);
      if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) continue;
      if (textEmptiesTrash(fs.readFileSync(file, "utf8"))) return true;
    } catch {
      // Not a file this command can mean.
    }
  }

  return false;
}

/**
 * Every shell the agent runs, wrapped: a command that would empty the trash
 * is not run, and the model is told to ask the user instead.
 */
export function withTrashGuard(operations: BashOperations): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      if (emptiesTrash(command, cwd)) {
        options.onData(Buffer.from(`${emptyTrashMessage()}\n`));
        return { exitCode: 1 };
      }

      return await operations.exec(command, cwd, options);
    },
  };
}

/**
 * The launchers on this process's own PATH, with a token that reaches
 * anywhere: every shell it starts inherits them, pi's built-in bash included.
 * A confined command gets its own narrower token (backends.ts).
 */
export function useTrashLaunchers(env: NodeJS.ProcessEnv = process.env): void {
  const next = trashShimEnv(env);
  for (const key of ["PATH", ...Object.values(TRASH_ENV)]) {
    if (next[key] != null) env[key] = next[key];
  }
}
