/**
 * What the app hands to `shell.openPath`. Any file that exists opens, wherever
 * it is, except a form the OS would run instead of show: that one is revealed
 * in the file manager, which runs nothing, so a link in a model's reply can
 * never launch a program in one click.
 */
import fs from "fs";
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

/** `reason` is a code; the renderer owns the user-facing message. */
export type LocalOpenDecision =
  /**
   * `path` is the resolved target the check ran against, so a symlink cannot
   * be re-pointed between check and open.
   */
  | { action: "open"; path: string }
  /** The OS would run it, so it is shown in the file manager instead. */
  | { action: "reveal"; reason: "executable"; path: string }
  | { action: "refuse"; reason: "invalid" | "missing" };

export const decideLocalOpen = (
  filePath: unknown,
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

  if (isExecutableForm(filePath, realTarget, platform)) {
    return { action: "reveal", reason: "executable", path: realTarget };
  }

  return { action: "open", path: realTarget };
};
