/**
 * Credential stores a shell command is not allowed to read. Reads stay
 * allow-by-default so toolchains keep working; only pure secret stores are
 * denied. Configuration files beside them are kept readable (`ssh -G`, a
 * public key, `~/.aws/config`), and `ABACUSAI_BOT_SANDBOX_READABLE` can exempt
 * a path for a tool that genuinely needs one.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A denied path with the files under it that are read back. */
export interface SecretEntry {
  path: string;
  /** Relative to `path`. Names, or `*.ext` for a suffix. */
  except?: string[];
  /**
   * A developer sometimes legitimately needs this one, so a command naming it
   * asks the user instead of failing. Stores nothing a coding task needs (the
   * app's own keys, browser cookies) are hidden without a prompt.
   */
  prompt?: boolean;
}

/** What is denied, as concrete existing paths the backends can name. */
export interface SecretPaths {
  /** Directories and files whose contents are hidden. */
  denied: string[];
  /** Files under a denied directory that stay readable. */
  allowed: string[];
  /** The subset of `denied` a command may ask to read. */
  promptable: string[];
}

/** Where the app keeps its own settings, API keys included. */
function appHome(env: NodeJS.ProcessEnv, home: string): string {
  const configured = (env.ABACUSAI_BOT_HOME ?? "").trim();

  return configured.length > 0 ? configured : path.join(home, ".abacusai-bot");
}

export function secretEntries(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): SecretEntry[] {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  const app = appHome(env, home);

  const entries: SecretEntry[] = [
    // Private keys. Config, known hosts and public keys stay readable so ssh
    // and `git push` through an agent still work.
    {
      path: at(".ssh"),
      except: [
        "config",
        "known_hosts",
        "known_hosts.old",
        "authorized_keys",
        "*.pub",
      ],
      prompt: true,
    },
    { path: at(".gnupg", "private-keys-v1.d"), prompt: true },
    { path: at(".gnupg", "secring.gpg"), prompt: true },
    // Cloud CLIs: the credential and token caches, not the config.
    { path: at(".aws", "credentials"), prompt: true },
    { path: at(".aws", "sso", "cache"), prompt: true },
    { path: at(".aws", "cli", "cache"), prompt: true },
    { path: at(".config", "gcloud", "credentials.db"), prompt: true },
    { path: at(".config", "gcloud", "access_tokens.db"), prompt: true },
    {
      path: at(".config", "gcloud", "application_default_credentials.json"),
      prompt: true,
    },
    { path: at(".config", "gcloud", "legacy_credentials"), prompt: true },
    { path: at(".azure", "msal_token_cache.json"), prompt: true },
    { path: at(".azure", "msal_token_cache.bin"), prompt: true },
    { path: at(".azure", "accessTokens.json"), prompt: true },
    { path: at(".azure", "service_principal_entries.json"), prompt: true },
    { path: at(".kube", "config"), prompt: true },
    { path: at(".docker", "config.json"), prompt: true },
    { path: at(".netrc"), prompt: true },
    { path: at(".pypirc"), prompt: true },
    // This app's own settings hold provider API keys, and the Electron
    // partition holds the in-app browser's cookies.
    { path: path.join(app, "config.json") },
    { path: path.join(app, "account.json") },
    { path: path.join(app, "messaging.json") },
    { path: path.join(app, "mcp-code.json") },
    { path: path.join(app, "electron") },
  ];

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? at("AppData", "Local");
    const roaming = env.APPDATA ?? at("AppData", "Roaming");
    entries.push(
      // DPAPI master keys and the Credential Manager vault.
      { path: path.join(roaming, "Microsoft", "Protect") },
      { path: path.join(roaming, "Microsoft", "Credentials") },
      { path: path.join(local, "Microsoft", "Credentials") },
      { path: path.join(local, "Google", "Chrome", "User Data") },
      { path: path.join(local, "Chromium", "User Data") },
      { path: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { path: path.join(local, "Microsoft", "Edge", "User Data") },
      { path: path.join(roaming, "Mozilla", "Firefox", "Profiles") }
    );
  } else if (platform === "darwin") {
    entries.push(
      { path: at("Library", "Keychains") },
      { path: at("Library", "Cookies") },
      { path: at("Library", "Safari") },
      { path: at("Library", "Application Support", "Google", "Chrome") },
      { path: at("Library", "Application Support", "Chromium") },
      { path: at("Library", "Application Support", "BraveSoftware") },
      { path: at("Library", "Application Support", "Microsoft Edge") },
      { path: at("Library", "Application Support", "Arc") },
      { path: at("Library", "Application Support", "Firefox") }
    );
  } else {
    entries.push(
      { path: at(".config", "google-chrome") },
      { path: at(".config", "chromium") },
      { path: at(".config", "BraveSoftware") },
      { path: at(".config", "microsoft-edge") },
      { path: at(".mozilla") },
      // Chromium and Firefox on Linux keep their password store here.
      { path: at(".local", "share", "keyrings") }
    );
  }

  return entries;
}

/** Whether `child` is `parent` or lies under it. */
export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Paths the user exempted, resolved. Empty when the variable is unset. */
export function readableExemptions(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string[] {
  return (env.ABACUSAI_BOT_SANDBOX_READABLE ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry === "~" || entry.startsWith("~/")
        ? path.join(home, entry.slice(1))
        : entry
    )
    .map((entry) => canonical(entry));
}

function canonical(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function matchesException(name: string, pattern: string): boolean {
  return pattern.startsWith("*.")
    ? name.endsWith(pattern.slice(1))
    : name === pattern;
}

/**
 * The concrete paths to deny and re-allow on this machine. Only paths that
 * exist are named: a mount over a missing directory fails outright in bwrap,
 * and a profile rule for a missing file is noise. A denied path containing the
 * workspace is skipped, since the user chose to work there; so is anything
 * under an exemption.
 */
export function resolveSecretPaths(options: {
  home?: string;
  workspaceRoot: string;
  exemptions?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  isDirectory?: (candidate: string) => boolean;
  list?: (dir: string) => string[];
}): SecretPaths {
  const home = options.home ?? os.homedir();
  const exemptions =
    options.exemptions ?? readableExemptions(options.env, home);
  const exists = options.exists ?? fs.existsSync;
  const isDirectory =
    options.isDirectory ??
    ((candidate: string): boolean => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
  const list =
    options.list ??
    ((dir: string): string[] => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    });

  const denied: string[] = [];
  const allowed: string[] = [];
  const promptable: string[] = [];

  for (const entry of secretEntries(home, options.platform, options.env)) {
    if (!exists(entry.path)) continue;

    const resolved = canonical(entry.path);
    if (isWithin(options.workspaceRoot, resolved)) continue;
    if (exemptions.some((exempt) => isWithin(resolved, exempt))) continue;
    if (denied.includes(resolved)) continue;

    denied.push(resolved);
    if (entry.prompt === true) promptable.push(resolved);

    if (!isDirectory(resolved)) continue;

    // An exemption inside a hidden directory (one approved key) is read back.
    for (const exempt of exemptions) {
      if (exempt !== resolved && isWithin(exempt, resolved) && exists(exempt))
        allowed.push(exempt);
    }

    if (entry.except == null) continue;

    for (const name of list(resolved)) {
      const child = path.join(resolved, name);
      if (
        entry.except.some((pattern) => matchesException(name, pattern)) &&
        exists(child) &&
        !isDirectory(child)
      ) {
        allowed.push(child);
      }
    }
  }

  return { denied, allowed, promptable };
}

const GLOB_CHARS = /[*?[]/;

/** Shell words that look like paths, `~` expanded and resolved against cwd. */
function pathWords(command: string, cwd: string, home: string): string[] {
  const words = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()]+/g) ?? [];
  const paths: string[] = [];

  for (const raw of words) {
    let word = raw.replace(/^["']|["']$/g, "");
    // `--identity=~/.ssh/id_rsa`, `key=~/.netrc`.
    const eq = word.indexOf("=");
    if (eq > 0 && (word[eq + 1] === "~" || word[eq + 1] === "/"))
      word = word.slice(eq + 1);
    if (word === "~" || word.startsWith("~/")) word = home + word.slice(1);
    if (!word.includes("/") && !word.startsWith(".")) continue;
    if (word.startsWith("-")) continue;

    // `~/.ssh/*` names the directory as far as the kernel is concerned.
    let resolved = path.resolve(cwd, word);
    while (GLOB_CHARS.test(path.basename(resolved)) && resolved !== "/") {
      resolved = path.dirname(resolved);
    }

    paths.push(canonical(resolved));
  }

  return paths;
}

/**
 * The promptable stores a command names, as the paths it named. Syntactic on
 * purpose: a command that reaches a store without naming it is stopped by the
 * kernel, and told so afterwards.
 */
export function namedSecretPaths(
  command: string,
  options: { cwd: string; promptable: readonly string[]; home?: string }
): string[] {
  if (options.promptable.length === 0) return [];

  const home = options.home ?? os.homedir();
  const named: string[] = [];

  for (const candidate of pathWords(command, options.cwd, home)) {
    if (
      options.promptable.some((store) => isWithin(candidate, store)) &&
      !named.includes(candidate)
    ) {
      named.push(candidate);
    }
  }

  return named;
}

/** Stores mentioned in a command's output, for the note appended on failure. */
export function mentionedSecretPaths(
  output: string,
  promptable: readonly string[]
): string[] {
  return promptable.filter((store) => output.includes(store));
}
