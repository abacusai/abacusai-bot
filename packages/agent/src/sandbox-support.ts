/**
 * Which kernel sandbox a platform has, decided from facts the desktop can
 * read without starting an agent. Its own entry so the Settings page can ask
 * the same question the agent answers (see sandbox/index.ts).
 */

export type SandboxBackend = "sandbox-runtime" | "sandy";

/** BusyBox's Unicode build requires Windows 10 1903. */
export const MINIMUM_WINDOWS_BUILD = 18362;

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
  release: string,
  arch: string = process.arch
): SandboxBackend | null {
  if (platform === "darwin" || platform === "linux") return "sandbox-runtime";
  // Sandy publishes x64; ARM64 needs Windows 11's x64 emulation.
  if (
    platform === "win32" &&
    (arch === "x64" || arch === "arm64") &&
    windowsBuild(release) >= (arch === "arm64" ? 22000 : MINIMUM_WINDOWS_BUILD)
  )
    return "sandy";

  return null;
}
