/**
 * Where a path the agent or the transcript names actually is on this
 * machine. The agent may write it three ways: under the guest workspace
 * prefix (a Docker backend mounts the workspace at `/workspace`), absolute,
 * or relative to the workspace. It also writes `~`, as a shell would, and a
 * literal `~` joined onto the workspace is a file that does not exist.
 */
import type { Stats } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";

/** Where the Docker backend mounts the workspace inside the guest. */
export const GUEST_WORKSPACE_PREFIX = "/workspace";

export function resolveHostPath(
  filePath: string,
  hostRoot: string,
  home: string = os.homedir()
): string {
  if (
    filePath.startsWith(GUEST_WORKSPACE_PREFIX + "/") ||
    filePath === GUEST_WORKSPACE_PREFIX
  ) {
    // Guest paths are POSIX (the guest is Linux); the host may not be.
    const rel = path.posix.relative(GUEST_WORKSPACE_PREFIX, filePath);

    return rel ? path.join(hostRoot, ...rel.split("/")) : hostRoot;
  }

  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(home, ...filePath.slice(2).split("/"));
  }

  if (path.isAbsolute(filePath)) return filePath;

  return path.join(hostRoot, ...filePath.split(/[\\/]/));
}

/**
 * Unicode spaces the model writes as a plain space. macOS names screenshots
 * with a narrow no-break space before "AM"; every transcript of that name
 * comes back with an ordinary one.
 */
const SPACE_VARIANTS_RE = /[   -​  　]/g;

/** A file name as a person reads it: composed, and one kind of space. */
const foldName = (name: string): string =>
  name.normalize("NFC").replace(SPACE_VARIANTS_RE, " ");

/**
 * The entry in `dir` that reads as `name`, when exactly one does. The model
 * transcribes file names from tool output and loses the characters a person
 * cannot see, so an exact miss is retried by how the name reads.
 */
async function siblingReadingAs(
  dir: string,
  name: string
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const wanted = foldName(name);
  const matches = entries.filter((entry) => foldName(entry) === wanted);

  return matches.length === 1 ? path.join(dir, matches[0]!) : null;
}

/**
 * The path that exists for a path the agent named: the path itself, or the
 * one entry in its directory that reads the same. Null when neither does.
 */
export async function locateHostFile(resolved: string): Promise<string | null> {
  try {
    await fs.access(resolved);
    return resolved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") return null;
  }
  return siblingReadingAs(path.dirname(resolved), path.basename(resolved));
}

export type HostFile =
  | { ok: true; realFile: string; stat: Stats }
  | {
      ok: false;
      error: "not-found" | "outside-root" | "not-a-file" | string;
    };

/**
 * The real file behind a path the agent named, checked to lie under
 * `hostRoot`. One place for the three IPC readers, so they agree on what
 * "found", "outside the root" and "not a file" mean.
 */
export async function openHostFile(
  filePath: string,
  hostRoot: string,
  home?: string
): Promise<HostFile> {
  const resolved = resolveHostPath(filePath, hostRoot, home);

  let realFile: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(hostRoot);
    const located = await locateHostFile(resolved);
    if (located == null) return { ok: false, error: "not-found" };
    realFile = await fs.realpath(located);
  } catch (err) {
    return {
      ok: false,
      error:
        (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
          ? "not-found"
          : err instanceof Error
            ? err.message
            : "realpath-failed",
    };
  }

  const rel = path.relative(realRoot, realFile);
  const escapes = !rel || rel.startsWith("..") || path.isAbsolute(rel);
  if (escapes && realFile !== realRoot) {
    return { ok: false, error: "outside-root" };
  }

  const stat = await fs.stat(realFile);
  if (!stat.isFile()) return { ok: false, error: "not-a-file" };

  return { ok: true, realFile, stat };
}
