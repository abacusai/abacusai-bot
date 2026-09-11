import fs from "fs";
import path from "path";

import type { NotificationSettings } from "#shared/contracts";
import { EXEC_BACKENDS, type BackendId } from "#shared/exec-backends";
import { PROVIDER_ENV_VARS, type AbacusBotSettings } from "#shared/settings";
import type { ToolsetPreferences } from "#shared/toolsets";

import { abacusBotHome } from "../../paths";

/**
 * User settings: `~/.abacusai-bot/config.json`, the same file the agent
 * reads, so a key entered in the UI and one written by hand are the same
 * thing. The environment always wins: a key exported in a shell profile takes
 * precedence over anything stored here.
 */

const configPath = (): string => path.join(abacusBotHome(), "config.json");

export const readSettings = (): AbacusBotSettings => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));

    return parsed != null && typeof parsed === "object"
      ? (parsed as AbacusBotSettings)
      : {};
  } catch {
    return {};
  }
};

const writeSettings = (settings: AbacusBotSettings): AbacusBotSettings => {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Merged, never replaced: the file is hand-editable and holds provider
  // definitions the UI knows nothing about. Temp file plus rename because it
  // has several writers, and a truncated file parses as `{}` for all of them.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  // The file holds API keys. chmod the temp so rename carries the mode, then
  // the target so an existing world-readable file does not keep its mode.
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows and some network filesystems lack POSIX modes.
  }
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Same as above.
  }

  return settings;
};

export const saveApiKey = (
  provider: string,
  key: string
): AbacusBotSettings => {
  const envVar = PROVIDER_ENV_VARS[provider];

  if (envVar == null) return readSettings();

  const settings = readSettings();
  const apiKeys = { ...settings.apiKeys };
  const trimmed = key.trim();

  if (trimmed.length === 0) {
    delete apiKeys[envVar];
  } else {
    apiKeys[envVar] = trimmed;
  }

  return writeSettings({ ...settings, apiKeys });
};

/**
 * Which providers have a key stored here. Ids only, never the keys: the
 * connect page only needs to know where to offer a Remove button.
 */
export const storedKeyProviders = (): string[] => {
  const apiKeys = readSettings().apiKeys ?? {};

  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVar]) => (apiKeys[envVar] ?? "").trim().length > 0)
    .map(([provider]) => provider);
};

export const setDefaultModel = (modelId: string): AbacusBotSettings => {
  const settings = readSettings();

  return writeSettings({ ...settings, defaultModel: modelId });
};

/**
 * Turn a toolset on or off for every workspace. Global rather than
 * per-project: the toggles say what this machine's agent may do. Only touched
 * groups are written, so the registry keeps the defaults.
 */
export const setToolsetEnabled = (
  toolsetId: string,
  enabled: boolean
): AbacusBotSettings => {
  const settings = readSettings();

  return writeSettings({
    ...settings,
    enabledToolsets: {
      ...settings.enabledToolsets,
      [toolsetId]: enabled,
    },
  });
};

export const readToolsetPreferences = (): ToolsetPreferences =>
  readSettings().enabledToolsets ?? {};

/** Unvalidated; `resolveBackend` decides if it is usable. */
export const readExecBackend = (): BackendId | undefined => {
  const stored = readSettings().execBackend;

  return EXEC_BACKENDS.some((backend) => backend.id === stored)
    ? (stored as BackendId)
    : undefined;
};

export const setExecBackend = (backend: BackendId): AbacusBotSettings =>
  writeSettings({ ...readSettings(), execBackend: backend });

/** Whether the OS sandbox is switched on. Absent means off. */
export const readSandboxEnabled = (): boolean =>
  readSettings().sandbox === true;

export const setSandboxEnabled = (enabled: boolean): AbacusBotSettings =>
  writeSettings({ ...readSettings(), sandbox: enabled });

/**
 * Whether X searches go to xAI's Live Search rather than the agent's own
 * search of x.com. A shell-exported `XAI_API_KEY` means yes, as
 * docs/capabilities.md promises. A key pasted into the connect page is a
 * model key and must not quietly route searches to xAI; that takes the toggle.
 */
export const readXaiSearchEnabled = (): boolean =>
  (process.env.XAI_API_KEY ?? "").trim().length > 0 ||
  readSettings().xaiSearch === true;

/** What the toggle shows and writes: the stored preference on its own. */
export const readXaiSearchPreference = (): boolean =>
  readSettings().xaiSearch === true;

export const setXaiSearchEnabled = (enabled: boolean): AbacusBotSettings =>
  writeSettings({ ...readSettings(), xaiSearch: enabled });

/** Both default on; stored inverted so absent reads as on. */
export const readNotificationSettings = (): NotificationSettings => {
  const stored = readSettings();

  return {
    enabled: stored.notificationsDisabled !== true,
    sound: stored.notificationSoundDisabled !== true,
  };
};

export const setNotificationSettings = (
  next: NotificationSettings
): NotificationSettings => {
  writeSettings({
    ...readSettings(),
    notificationsDisabled: !next.enabled,
    notificationSoundDisabled: !next.sound,
  });

  return readNotificationSettings();
};

export const readDockerImage = (): string | undefined => {
  const stored = (readSettings().execDockerImage ?? "").trim();

  return stored.length > 0 ? stored : undefined;
};

/** Credentials for the agent's environment; the environment wins. */
export const credentialEnv = (): Record<string, string> => {
  const stored = readSettings().apiKeys ?? {};
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(stored)) {
    if ((process.env[name] ?? "").length === 0 && value.length > 0) {
      env[name] = value;
    }
  }

  return env;
};

/**
 * The usable value of one credential, for tools that run in this process.
 * Spawn-time injection only helps children; a packaged app launched from
 * Finder has an empty environment, so an env-only read misses stored keys.
 */
export const credentialFor = (envVar: string): string => {
  const fromEnv = (process.env[envVar] ?? "").trim();

  if (fromEnv.length > 0) return fromEnv;

  return (readSettings().apiKeys?.[envVar] ?? "").trim();
};

/** Whether a provider can run: an env var, or a key stored here. */
export const hasCredential = (envVar: string | undefined): boolean => {
  if (envVar == null) return false;

  const stored = readSettings().apiKeys ?? {};

  return (
    (process.env[envVar] ?? "").length > 0 || (stored[envVar] ?? "").length > 0
  );
};

/**
 * Whether pi holds an OAuth credential for a provider. Subscription-backed
 * providers (`openai-codex`) have no key to type, so an env var cannot judge
 * them, and "no env var" must not read as available.
 */
export const hasOAuthCredential = (provider: string): boolean => {
  try {
    const authPath = path.join(abacusBotHome(), "agent", "auth.json");
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      unknown
    >;

    return parsed[provider] != null;
  } catch {
    return false;
  }
};
