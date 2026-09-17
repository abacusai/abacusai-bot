/**
 * Which machine an upload came from, so a transcript, log batch or diagnostics
 * snapshot can be read against it: OS name and version, kernel release, CPU
 * architecture, locale. Nothing here names the user or the hardware.
 */
import fs from "node:fs";
import os from "node:os";

/** snake_case: these fields go straight into the /v1 sync payloads. */
export interface ClientEnvironment {
  platform: string;
  arch: string;
  /** "macOS", "Windows", or the distro's own name on Linux. */
  os_name: string;
  /** The version a user would recognize: "26.0.1", "10.0.22631", "24.04". */
  os_version: string;
  /** Kernel release, which is all `os.release()` reports on macOS. */
  os_release: string;
  /** An x64 build on an arm64 machine: Rosetta 2, or Windows on ARM. */
  arm64_translated: boolean;
  locale: string;
}

/** Injected by tests; every default reads the real machine. */
export interface EnvironmentProbes {
  platform?: string;
  arch?: string;
  release?: () => string;
  cpuModel?: () => string;
  /** Electron's `process.getSystemVersion()`; there is no Node equivalent. */
  systemVersion?: () => string | null;
  /** Linux only: the contents of `/etc/os-release`. */
  osRelease?: () => string | null;
  locale?: () => string;
  env?: NodeJS.ProcessEnv;
}

export function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** `KEY=value` / `KEY="value"` lines, as `/etc/os-release` is defined. */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_]+)=(.*)$/.exec(line);
    if (match == null) continue;
    fields[match[1]] = match[2].trim().replace(/^"(.*)"$/s, "$1");
  }
  return fields;
}

function electronSystemVersion(): string | null {
  const getter = (process as { getSystemVersion?: () => string })
    .getSystemVersion;
  return typeof getter === "function" ? getter() : null;
}

function describeOs(
  platform: string,
  release: string,
  systemVersion: string | null,
  osReleaseFile: string | null
): { name: string; version: string } {
  // Only Linux names itself in a file; macOS and Windows answer the Electron call.
  if (osReleaseFile != null) {
    const fields = parseOsRelease(osReleaseFile);
    return {
      name: fields.NAME ?? fields.ID ?? platform,
      version: fields.VERSION_ID ?? fields.VERSION ?? release,
    };
  }
  const name =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : platform;
  return { name, version: systemVersion ?? release };
}

/**
 * An x64 build on an arm64 machine. Rosetta leaves the real CPU brand in
 * place, and WOW64 keeps the host architecture in `PROCESSOR_ARCHITEW6432`.
 */
function looksTranslated(
  platform: string,
  arch: string,
  probes: EnvironmentProbes
): boolean {
  if (arch !== "x64") return false;
  if (platform === "darwin")
    return safely(
      probes.cpuModel ?? (() => os.cpus()[0]?.model ?? ""),
      ""
    ).startsWith("Apple ");
  if (platform === "win32")
    return (
      (probes.env ?? process.env).PROCESSOR_ARCHITEW6432?.toUpperCase() ===
      "ARM64"
    );
  return false;
}

export function collectClientEnvironment(
  probes: EnvironmentProbes = {}
): ClientEnvironment {
  const platform = probes.platform ?? process.platform;
  const arch = probes.arch ?? process.arch;
  const release = safely(probes.release ?? (() => os.release()), "unknown");
  const { name, version } = describeOs(
    platform,
    release,
    safely(probes.systemVersion ?? electronSystemVersion, null),
    platform === "linux"
      ? safely(probes.osRelease ?? readEtcOsRelease, null)
      : null
  );

  return {
    platform,
    arch,
    os_name: name,
    os_version: version,
    os_release: release,
    arm64_translated: looksTranslated(platform, arch, probes),
    locale: safely(
      probes.locale ??
        (() => Intl.DateTimeFormat().resolvedOptions().locale ?? "unknown"),
      "unknown"
    ),
  };
}

function readEtcOsRelease(): string | null {
  return safely(() => fs.readFileSync("/etc/os-release", "utf-8"), null);
}

let cached: ClientEnvironment | null = null;

/** Cached: none of it changes while the app runs. */
export function clientEnvironment(): ClientEnvironment {
  return (cached ??= collectClientEnvironment());
}

/** One line for the log dump and any other human-read surface. */
export function formatClientEnvironment(env: ClientEnvironment): string {
  return [
    `os: ${env.os_name} ${env.os_version} (${env.platform} ${env.os_release})`,
    `arch: ${env.arch}${env.arm64_translated ? " (translated on arm64)" : ""}`,
    `locale: ${env.locale}`,
  ].join("  ");
}
