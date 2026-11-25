/**
 * Running the user's own `gh`: finding the binary, a quiet non-interactive
 * environment, and sorting its failures into what the UI can explain
 * (not installed, not signed in, no pull request, not a GitHub checkout).
 * Nothing here holds a token; `gh` brings its own login.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { childProcessEnv } from "@abacus-ai/agent/child-env";

/** Never a prompt, pager, colour or update notice: output is parsed. */
const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GH_DEBUG: "",
};

export const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Where installers put `gh`, searched after PATH: an app opened from Finder
 * can run before the login-shell PATH is applied, and then sees only
 * `/usr/bin:/bin`.
 */
export const ghFallbackDirs = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] =>
  platform === "win32"
    ? [
        path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI"),
        path.win32.join(
          env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          "GitHub CLI"
        ),
        ...(env.LOCALAPPDATA == null
          ? []
          : [path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI")]),
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/snap/bin",
        path.posix.join(home, ".local", "bin"),
        // Version managers put a shim here, PATH-only otherwise.
        path.posix.join(home, ".local", "share", "mise", "shims"),
        path.posix.join(home, ".asdf", "shims"),
        path.posix.join(home, ".nix-profile", "bin"),
      ];

/** The first `gh` on PATH, then in the usual install directories; null when none. */
export function resolveGhBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = isFile,
  home: string = os.homedir()
): string | null {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathValue =
    platform === "win32"
      ? (Object.entries(env).find(
          ([key]) => key.toUpperCase() === "PATH"
        )?.[1] ?? "")
      : (env.PATH ?? "");
  const names = platform === "win32" ? ["gh.exe", "gh"] : ["gh"];
  const dirs = [
    ...pathValue.split(delimiter).filter((dir) => dir.length > 0),
    ...ghFallbackDirs(platform, env, home),
  ];
  for (const dir of dirs)
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  return null;
}

export type GhFailureKind =
  /** No `gh` binary. */
  | "missing"
  /** Installed, with no working login. */
  | "unauthenticated"
  /** The branch has no pull request (or HEAD is detached). */
  | "none"
  /** Not a git checkout, or no GitHub remote. */
  | "unsupported"
  | "timeout"
  | "error";

/** A failed `gh` run, sorted; `message` is the first line worth showing. */
export class GhError extends Error {
  constructor(
    readonly kind: GhFailureKind,
    message: string,
    readonly stderr = ""
  ) {
    super(message);
    this.name = "GhError";
  }
}

/** What `execFile` reports on a failure, as far as sorting needs. */
export interface GhFailure {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  message?: string;
  stderr?: string;
}

const firstLine = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

/**
 * gh's own line as a sentence the user can act on ("Can not approve your
 * own pull request"), or null when it carries internals: a URL, a path, an
 * HTTP status, JSON or a stack. Its "GraphQL:" lead and the operation's
 * name in brackets are dropped.
 */
export const plainGhSentence = (line: string): string | null => {
  const text = line
    .trim()
    .replace(/^(?:GraphQL|gh|error):\s*/i, "")
    .replace(/\s*\([A-Za-z]+\)\.?$/, "")
    .trim();
  if (text === "" || text.length > 160) return null;
  if (
    /https?:|[\\/{}[\]<>`$]|\bHTTP\b|\b\d{3}\b|\bat\s+\S+:\d|[A-Z_]{4,}/.test(
      text
    )
  )
    return null;
  return text;
};

/**
 * A failure as a status line: the app's own sentences (gh missing, timed
 * out, signed out) and gh's plain ones are for the user; anything else
 * keeps its text for the log, unmarked.
 */
export const ghStatusMessage = (
  error: unknown
): { message: string; userFacing: boolean } => {
  if (!(error instanceof GhError))
    return {
      message: error instanceof Error ? error.message : String(error),
      userFacing: false,
    };
  if (
    error.kind === "missing" ||
    error.kind === "timeout" ||
    error.kind === "unauthenticated"
  )
    return { message: error.message, userFacing: true };
  const plain = plainGhSentence(error.message);
  return plain != null
    ? { message: plain, userFacing: true }
    : { message: error.message, userFacing: false };
};

/** Sorts a failed run by its error code and stderr (spec: classification table). */
export function classifyGhFailure(failure: GhFailure): GhError {
  const stderr = failure.stderr ?? "";
  if (failure.code === "ENOENT")
    return new GhError("missing", "GitHub CLI (gh) is not installed", stderr);
  // A timeout's kill, which `execFile` reports as killed with a signal.
  if (failure.killed === true && failure.signal != null)
    return new GhError("timeout", "GitHub CLI did not answer in time", stderr);
  if (
    /gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(
      stderr
    )
  )
    return new GhError(
      "unauthenticated",
      "GitHub CLI is not signed in; run `gh auth login`",
      stderr
    );
  if (
    /not a git repository|none of the git remotes|no git remotes|not a github (repository|host)/i.test(
      stderr
    )
  )
    return new GhError("unsupported", firstLine(stderr), stderr);
  if (
    /no pull requests found|could not determine current branch|not on any branch/i.test(
      stderr
    )
  )
    return new GhError("none", firstLine(stderr), stderr);
  return new GhError(
    "error",
    firstLine(stderr) || failure.message || "GitHub CLI failed",
    stderr
  );
}

export interface GhRunOptions {
  cwd?: string;
  /** Written to stdin (`--body-file -`). */
  input?: string;
  timeoutMs?: number;
  /** Past it the output is cut at its last whole line and `truncated`. */
  maxBuffer?: number;
}

export interface GhOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** `runGh`'s shape, so services and tests can swap the process for a fake. */
export type GhRunner = (
  args: readonly string[],
  options?: GhRunOptions
) => Promise<GhOutput>;

let resolvedBinary: string | null | undefined;

/** Runs `gh`; any failure rejects with a sorted `GhError`. */
export const runGh: GhRunner = (args, options = {}) => {
  resolvedBinary ??= resolveGhBinary();
  const binary = resolvedBinary;
  if (binary == null) {
    resolvedBinary = undefined;
    return Promise.reject(classifyGhFailure({ code: "ENOENT" }));
  }
  const maxBuffer = options.maxBuffer ?? GH_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [...args],
      {
        cwd: options.cwd,
        env: childProcessEnv(process.env, GH_ENV),
        timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
        maxBuffer,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error == null) {
          resolve({ stdout, stderr, truncated: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          const cut = stdout.lastIndexOf("\n");
          resolve({
            stdout: cut === -1 ? stdout : stdout.slice(0, cut + 1),
            stderr,
            truncated: true,
          });
          return;
        }
        if (code === "ENOENT") resolvedBinary = undefined;
        reject(
          classifyGhFailure({
            code,
            killed: error.killed,
            signal: error.signal,
            message: error.message,
            stderr,
          })
        );
      }
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
};

/** `gh version 2.81.0 (2025-10-01)` → `2.81.0`. */
export function parseGhVersion(stdout: string): string | null {
  return /gh version (\d+\.\d+\.\d+[^\s]*)/i.exec(stdout)?.[1] ?? null;
}

export interface GhAuth {
  signedIn: boolean;
  account: string | null;
  host: string | null;
  /** Why not, when not signed in. */
  message: string | null;
}

const NOT_SIGNED_IN = "Not signed in to GitHub; run `gh auth login`";

/**
 * `gh auth status --json hosts` (gh ≥ 2.81): the active account answers when
 * there is one (a broken `GH_TOKEN` is active over a good keyring login, and
 * every call uses it); otherwise any working login. Null when the output is
 * not that JSON, so the caller falls back to the text form.
 */
export function parseAuthStatusJson(stdout: string): GhAuth | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const hosts = (data as { hosts?: unknown } | null)?.hosts;
  if (hosts == null || typeof hosts !== "object" || Array.isArray(hosts))
    return null;
  const accounts = Object.entries(hosts as Record<string, unknown>).flatMap(
    ([host, entries]) =>
      Array.isArray(entries)
        ? entries.map((entry: Record<string, unknown> | null) => ({
            host: typeof entry?.host === "string" ? entry.host : host,
            login: typeof entry?.login === "string" ? entry.login : "",
            ok: entry?.state === "success",
            active: entry?.active === true,
            error: typeof entry?.error === "string" ? entry.error : null,
          }))
        : []
  );
  const chosen =
    accounts.find((account) => account.active) ??
    accounts.find((account) => account.ok);
  if (chosen?.ok === true)
    return {
      signedIn: true,
      account: chosen.login || null,
      host: chosen.host,
      message: null,
    };
  return {
    signedIn: false,
    account: null,
    host: null,
    message:
      chosen == null
        ? NOT_SIGNED_IN
        : `The GitHub login for ${chosen.host} no longer works; run \`gh auth login\``,
  };
}

/**
 * Plain `gh auth status` (any gh): exit 0 means a working login. The account
 * is read from "Logged in to HOST account LOGIN" (or the older "as LOGIN"),
 * preferring the one not marked "Active account: false".
 */
export function parseAuthStatusText(output: string, exitedOk: boolean): GhAuth {
  if (!exitedOk)
    return {
      signedIn: false,
      account: null,
      host: null,
      message: NOT_SIGNED_IN,
    };
  const lines = output.split(/\r?\n/);
  const logins: Array<{ host: string; account: string; active: boolean }> = [];
  for (const line of lines) {
    const match = /Logged in to (\S+) (?:account|as) (\S+)/i.exec(line);
    if (match != null) {
      logins.push({ host: match[1], account: match[2], active: true });
      continue;
    }
    const last = logins.at(-1);
    if (last != null && /Active account:\s*false/i.test(line))
      last.active = false;
  }
  const chosen = logins.find((login) => login.active) ?? logins[0];
  return {
    signedIn: true,
    account: chosen?.account ?? null,
    host: chosen?.host ?? null,
    message: null,
  };
}
