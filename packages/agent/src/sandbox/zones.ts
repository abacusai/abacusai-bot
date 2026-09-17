/**
 * Where a path lands, for the question "may a command write here without
 * asking?" The workspace and scratch are the kernel's own allow list; tool
 * homes are the caches and toolchains a build writes to as a matter of
 * course; the user's own folders are where "save it on my Desktop" goes.
 * Everything under a dotfile, the system, or ~/Library is off limits without
 * a card, whatever the command.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalize } from "./policy.js";
import { isWithin } from "./secrets.js";

export type Zone =
  /** Inside the workspace: the kernel allows it already. */
  | "workspace"
  /** /tmp and the platform temp dir: the kernel allows it already. */
  | "scratch"
  /** A cache or toolchain directory a build writes to on its own. */
  | "toolhome"
  /** The user's own folders: Desktop, Documents, a project beside the workspace. */
  | "user"
  /** Dotfiles, the system, ~/Library, credential stores: never without a card. */
  | "sensitive"
  /** Anywhere else (another volume, /opt): not granted, the kernel decides. */
  | "other";

/**
 * Directories a package manager or toolchain writes to as part of any build.
 * Relative to home; only the ones that exist are used, since bubblewrap
 * cannot bind a directory that is not there.
 */
const TOOL_HOMES = [
  ".npm",
  ".cache",
  ".local/share",
  ".local/state",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  "go/pkg",
  ".m2",
  ".gradle",
  ".pnpm-store",
  ".yarn",
  ".bun/install/cache",
  ".nvm",
  ".fnm",
  ".pyenv",
  ".rbenv",
  ".conda/pkgs",
  "Library/Caches",
  "Library/pnpm",
  "Library/Application Support/pnpm",
];

const SYSTEM_ROOTS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/var",
  "/System",
  "/Library",
  "/Applications",
  "/boot",
  "/root",
];

/**
 * Tool homes that exist on this machine, canonical, so they can go straight
 * onto the kernel's write list. `XDG_CACHE_HOME` and `XDG_DATA_HOME` count
 * when set, since that is where a Linux build's caches then live.
 */
export function existingToolHomes(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates = [
    ...TOOL_HOMES.map((entry) => path.join(home, entry)),
    ...["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
      .map((name) => (env[name] ?? "").trim())
      .filter((value) => value.length > 0 && path.isAbsolute(value)),
  ];
  const found = new Set<string>();
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory())
        found.add(canonicalize(candidate));
    } catch {
      // Not there: nothing to bind.
    }
  }

  return [...found];
}

export interface ZoneContext {
  workspaceRoot: string;
  writableTemp: readonly string[];
  toolHomes: readonly string[];
  home?: string;
}

/** The context for a workspace, with the machine's temp dirs and tool homes. */
export function zoneContext(cwd: string): ZoneContext {
  const temps = new Set<string>();
  for (const candidate of ["/tmp", os.tmpdir()]) {
    if (candidate) temps.add(canonicalize(candidate));
  }

  return {
    workspaceRoot: canonicalize(cwd),
    writableTemp: [...temps],
    toolHomes: existingToolHomes(),
  };
}

/**
 * The zone of an absolute path; a link is judged by where it really lands.
 * `directory` says the path is, or is about to be, a directory: a folder
 * made straight under home is a project of the user's, a loose file there
 * is nobody's folder.
 */
export function zoneOf(
  absolute: string,
  context: ZoneContext,
  directory = false
): Zone {
  const target = canonicalize(absolute);
  const home = canonicalize(context.home ?? os.homedir());

  if (isWithin(target, context.workspaceRoot)) return "workspace";
  if (context.writableTemp.some((temp) => isWithin(target, temp)))
    return "scratch";
  if (context.toolHomes.some((dir) => isWithin(target, dir))) return "toolhome";

  if (isWithin(target, home)) {
    const parts = path.relative(home, target).split(path.sep);
    const [first] = parts;
    if (first == null || first === "" || first.startsWith("."))
      return "sensitive";
    if (first === "Library") return "sensitive";
    // A loose file in home itself is nobody's folder; Desktop, Documents, a
    // project directory beside the workspace are the user's.
    return parts.length === 1 && !directory ? "sensitive" : "user";
  }

  // Canonical as well as spelled: /etc is /private/etc on macOS.
  if (
    SYSTEM_ROOTS.some(
      (root) => isWithin(target, root) || isWithin(target, canonicalize(root))
    )
  )
    return "sensitive";

  return "other";
}
