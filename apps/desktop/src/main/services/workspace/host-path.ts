/**
 * Where a path the agent or the transcript names actually is on this
 * machine. The agent may write it three ways: under the guest workspace
 * prefix (a Docker backend mounts the workspace at `/workspace`), absolute,
 * or relative to the workspace. It also writes `~`, as a shell would, and a
 * literal `~` joined onto the workspace is a file that does not exist.
 */
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
