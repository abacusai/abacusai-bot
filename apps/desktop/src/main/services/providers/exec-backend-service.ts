/**
 * Which execution backend is selected, and which ones could be. Readiness is
 * probed, not assumed, so nobody picks a backend that fails on its first
 * command with a confusing tool error instead of "Docker isn't installed".
 */
import { execFileSync } from "child_process";

import {
  DEFAULT_BACKEND,
  SELECTABLE_EXEC_BACKENDS,
  type BackendId,
  type BackendStatus,
  type ExecBackend,
} from "#shared/exec-backends";

/**
 * Binary lookups are cached for the process lifetime; shelling out on every
 * panel render is not free. `refresh` clears it for mid-session installs.
 */
const binaryCache = new Map<string, boolean>();

const hasBinary = (command: string): boolean => {
  const cached = binaryCache.get(command);

  if (cached != null) return cached;

  let found = false;

  try {
    if (process.platform === "win32") {
      // No /bin/sh here; `where` does the PATH walk (PATHEXT included).
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      // Through the login shell: GUI apps on macOS inherit a minimal PATH
      // without /usr/local/bin or Homebrew, so a bare probe misses Docker.
      execFileSync("/bin/sh", ["-lc", `command -v ${command}`], {
        stdio: "ignore",
      });
    }
    found = true;
  } catch {
    found = false;
  }

  binaryCache.set(command, found);

  return found;
};

const statusFor = (backend: ExecBackend): BackendStatus => {
  if (!backend.implemented) {
    return { id: backend.id, ready: false, blocker: { kind: "unimplemented" } };
  }

  // The workspace is mounted at its host path, and a `C:\` path is never a
  // valid workdir in a Linux guest. Checked before the binary probe, which a
  // present docker.exe would otherwise pass.
  if (backend.id === "docker" && process.platform === "win32") {
    return {
      id: backend.id,
      ready: false,
      blocker: { kind: "unsupported-platform" },
    };
  }

  if (backend.requires.kind === "binary") {
    return hasBinary(backend.requires.command)
      ? { id: backend.id, ready: true }
      : {
          id: backend.id,
          ready: false,
          blocker: {
            kind: "missing-binary",
            command: backend.requires.command,
          },
        };
  }

  if (backend.requires.kind === "env") {
    const missing = backend.requires.vars.filter(
      (name) => (process.env[name] ?? "").trim().length === 0
    );

    return missing.length === 0
      ? { id: backend.id, ready: true }
      : {
          id: backend.id,
          ready: false,
          blocker: { kind: "missing-env", vars: missing },
        };
  }

  return { id: backend.id, ready: true };
};

export const backendStatuses = (): BackendStatus[] =>
  SELECTABLE_EXEC_BACKENDS.map(statusFor);

export const clearBackendProbeCache = (): void => {
  binaryCache.clear();
};

/**
 * The backend to actually use. A stored choice that became unusable (Docker
 * uninstalled, a token removed) falls back to local rather than failing every
 * command; the panel shows what is in effect, not just what was chosen.
 */
export const resolveBackend = (stored: BackendId | undefined): BackendId => {
  const requested = stored ?? DEFAULT_BACKEND;
  const status = backendStatuses().find((entry) => entry.id === requested);

  return status?.ready === true ? requested : DEFAULT_BACKEND;
};
