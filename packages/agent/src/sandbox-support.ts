/**
 * Which kernel sandbox a platform has, decided from facts the desktop can
 * read without starting an agent. Its own entry so the Settings page can ask
 * the same question the agent answers (see sandbox/index.ts).
 */

export type SandboxBackend = "sandbox-runtime" | "mxc";

/** The first Windows build whose process containers the MXC runner supports. */
export const MINIMUM_WINDOWS_BUILD = 26100;

/** The build number in an `os.release()` string such as `10.0.26100`. */
export function windowsBuild(release: string): number {
  const build = Number(release.split(".")[2] ?? 0);

  return Number.isFinite(build) ? build : 0;
}

/**
 * The backend a platform has at all, working or not. An older Windows has
 * none rather than a broken one, so `auto` runs unconfined there and says so.
 */
export function sandboxBackendFor(
  platform: NodeJS.Platform,
  release: string
): SandboxBackend | null {
  if (platform === "darwin" || platform === "linux") return "sandbox-runtime";
  if (platform === "win32" && windowsBuild(release) >= MINIMUM_WINDOWS_BUILD)
    return "mxc";

  return null;
}
