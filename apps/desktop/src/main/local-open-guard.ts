/**
 * What the app is willing to hand to `shell.openPath`. The paths come from
 * model-generated markdown and an agent-written workspace, so a path opens
 * only inside a directory the app treats as the user's working area, and
 * never when the OS would run it instead of showing it. An executable inside
 * an allowed root is revealed in the file manager rather than dropped.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** Windows runs these on open; `.lnk`/`.url` launch whatever they point at. */
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".lnk",
  ".url",
  ".pif",
  ".ps1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".wsc",
  ".hta",
  ".msi",
  ".msc",
  ".cpl",
  ".reg",
  ".scf",
]);

/** Extensions macOS runs on open: Terminal scripts and launchable bundles. */
const MACOS_EXECUTABLE_EXTENSIONS = new Set([
  ".command",
  ".terminal",
  ".app",
  ".workflow",
]);

/** A desktop entry is a launcher, not a document. */
const LINUX_EXECUTABLE_EXTENSIONS = new Set([".desktop"]);

/** Lowercased extension, or "" when there is none. */
const extensionOf = (filePath: string, stripTrailing: boolean): string => {
  const raw = path.basename(filePath);
  const name = stripTrailing ? raw.replace(/[. ]+$/, "") : raw;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
};

/**
 * Trailing dots/spaces are stripped because Windows ignores them ("evil.exe ."
 * opens evil.exe); the comparison is case-insensitive because NTFS is.
 */
export const hasWindowsExecutableExtension = (filePath: string): boolean =>
  WINDOWS_EXECUTABLE_EXTENSIONS.has(extensionOf(filePath, true));

/** A regular file the OS will run because its execute bit is set. */
const hasExecuteBit = (target: string): boolean => {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** First bytes of ELF, of the Mach-O variants, and of a universal binary. */
const BINARY_MAGIC = new Set([
  "7f454c46",
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
]);

/**
 * Whether the contents say "run me". The execute bit alone does not: FAT,
 * exFAT and NTFS mounts synthesize 0755 for every file, README included.
 */
const looksRunnable = (target: string): boolean => {
  let handle: number | undefined;

  try {
    handle = fs.openSync(target, "r");

    const head = Buffer.alloc(4);
    const read = fs.readSync(handle, head, 0, 4, 0);

    if (read >= 2 && head[0] === 0x23 && head[1] === 0x21) return true;

    return read === 4 && BINARY_MAGIC.has(head.toString("hex"));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing to do about a close that fails.
      }
    }
  }
};

/** Checks the name as given and the resolved target: a link cannot hide one. */
const isExecutableForm = (
  given: string,
  resolved: string,
  platform: NodeJS.Platform
): boolean => {
  if (platform === "win32") {
    return (
      hasWindowsExecutableExtension(given) ||
      hasWindowsExecutableExtension(resolved)
    );
  }

  const extensions =
    platform === "darwin"
      ? MACOS_EXECUTABLE_EXTENSIONS
      : LINUX_EXECUTABLE_EXTENSIONS;
  if (
    extensions.has(extensionOf(given, false)) ||
    extensions.has(extensionOf(resolved, false))
  ) {
    return true;
  }

  // +x is only evidence when the contents agree (see looksRunnable).
  return hasExecuteBit(resolved) && looksRunnable(resolved);
};

/** True when `target` is `root` or inside it (boundary-aware, not substring). */
const isWithin = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Realpath'd like the targets (macOS: /var/folders -> /private/var/folders). */
const realTmpdir = ((): string => {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
})();

/**
 * A temp file owned by another local account. The temp dir is an allowed root
 * for agent scratch files, and on Linux `/tmp` is shared with every account.
 */
const isForeignTempFile = (
  resolved: string,
  platform: NodeJS.Platform
): boolean => {
  if (platform !== "linux") return false;
  if (!isWithin(realTmpdir, resolved)) return false;

  const uid = process.getuid?.();
  if (uid == null) return false;

  try {
    return fs.statSync(resolved).uid !== uid;
  } catch {
    // A file that cannot be stat'd will not open anyway.
    return false;
  }
};

/** `reason` is a code; the renderer owns the user-facing message. */
export type LocalOpenDecision =
  /**
   * `path` is the resolved target the checks ran against, so a symlink cannot
   * be re-pointed between check and open.
   */
  | { action: "open"; path: string }
  /** Safe to show in the file manager, not to hand to the OS to run. */
  | { action: "reveal"; reason: "executable"; path: string }
  | { action: "refuse"; reason: "invalid" | "missing" | "outside" };

/**
 * Target and roots are realpath'd before the boundary check, so a symlink
 * cannot smuggle the open outside an allowed root (or hide macOS's /tmp link).
 */
export const decideLocalOpen = (
  filePath: unknown,
  allowedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform
): LocalOpenDecision => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { action: "refuse", reason: "invalid" };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(filePath);
  } catch {
    return { action: "refuse", reason: "missing" };
  }

  const inside = allowedRoots.some((root) => {
    if (typeof root !== "string" || root.length === 0) return false;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return false;
    }
    return isWithin(realRoot, realTarget);
  });
  if (!inside) return { action: "refuse", reason: "outside" };
  // Inside the temp root by position, but somebody else's file.
  if (isForeignTempFile(realTarget, platform))
    return { action: "refuse", reason: "outside" };

  if (isExecutableForm(filePath, realTarget, platform)) {
    return { action: "reveal", reason: "executable", path: realTarget };
  }

  return { action: "open", path: realTarget };
};
