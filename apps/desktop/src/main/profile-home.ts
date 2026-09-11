import fs from "fs";
import os from "os";
import path from "path";

/**
 * One home folder per Abacus.AI account. A registry at the base dir maps an
 * account key to a profile folder and this module points `ABACUSAI_BOT_HOME`
 * at the active one before anything reads a path. The first account adopts
 * the base itself; later ones get `profiles/<key>/`. Switching relaunches,
 * because stores are singletons opened at module load. Must stay import-light.
 */

interface ProfileRegistry {
  /** The account key whose profile this install is currently using. */
  active: string | null;
  /** Account key -> profile dir, relative to the base ("." = the base itself). */
  profiles: Record<string, string>;
}

/**
 * Anchored in its own env var: this module mutates ABACUSAI_BOT_HOME and
 * `app.relaunch()` hands the child that mutated environment, which would
 * nest the next profile under the last one (`profiles/A/profiles/B`).
 */
const BASE =
  process.env.ABACUSAI_BOT_BASE ||
  process.env.ABACUSAI_BOT_HOME ||
  path.join(os.homedir(), ".abacusai-bot");
const REGISTRY_FILE = "profiles.json";

/** The install-wide directory that owns the profile registry and every profile. */
export const profileBaseDir = (): string =>
  process.env.ABACUSAI_BOT_BASE || process.env.ABACUSAI_BOT_HOME || BASE;

const registryPath = (): string => path.join(BASE, REGISTRY_FILE);

const readRegistry = (): ProfileRegistry => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    const reg = parsed as Partial<ProfileRegistry>;

    const profiles: Record<string, string> = {};
    if (reg.profiles != null && typeof reg.profiles === "object") {
      for (const [key, value] of Object.entries(reg.profiles)) {
        if (typeof value !== "string") continue;
        const resolved = path.resolve(BASE, value);
        const relative = path.relative(BASE, resolved);
        // A registry must never point outside the directory the app owns.
        if (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== "..")
        ) {
          profiles[key] = value;
        }
      }
    }
    const active =
      typeof reg.active === "string" && profiles[reg.active] != null
        ? reg.active
        : null;

    return { active, profiles };
  } catch {
    return { active: null, profiles: {} };
  }
};

const writeRegistry = (registry: ProfileRegistry): void => {
  fs.mkdirSync(BASE, { recursive: true });
  const target = registryPath();
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The rename already made the registry whole; a stray temp file is fine.
    }
  }
};

const profileDir = (registry: ProfileRegistry, key: string): string =>
  path.resolve(BASE, registry.profiles[key] ?? ".");

/** The home this process should use right now. */
const activeHome = (): string => {
  const registry = readRegistry();
  if (registry.active == null) return BASE;

  return profileDir(registry, registry.active);
};

/** Called before any module that reads `abacusBotHome()` loads. */
export const initProfileHome = (): void => {
  process.env.ABACUSAI_BOT_BASE = BASE;
  // Unconditional: a relaunch inherits the previous process's mutated value.
  process.env.ABACUSAI_BOT_HOME = activeHome();
};

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

/**
 * Null when the account cannot be identified, so the caller stays put instead
 * of filing an unknown account into the active user's directory.
 */
export const profileKeyFor = (account: {
  user_id?: string | null;
  organization_id?: string | null;
  email?: string | null;
  organization?: string | null;
}): string | null => {
  const userId = slug(account.user_id ?? "");
  const organizationId = slug(account.organization_id ?? "");
  const organization = slug(account.organization ?? "");
  if (userId.length > 0) {
    return (
      organizationId.length > 0
        ? `user-${userId}_org-${organizationId}`
        : organization.length > 0
          ? `user-${userId}_org-name-${organization}`
          : `user-${userId}`
    ).slice(0, 120);
  }

  const email = slug(account.email ?? "");
  if (email.length === 0) return null;

  return (organization.length > 0 ? `${email}_${organization}` : email).slice(
    0,
    120
  );
};

/** The email-based key used before stable platform ids were exposed. */
export const legacyProfileKeyFor = (account: {
  email?: string | null;
  organization?: string | null;
}): string | null => {
  const email = slug(account.email ?? "");
  if (email.length === 0) return null;
  const organization = slug(account.organization ?? "");

  return (organization.length > 0 ? `${email}_${organization}` : email).slice(
    0,
    120
  );
};

/**
 * Make `key` the active profile. Returns true when it lands in a different
 * folder than this process uses; the caller must relaunch then. In that case
 * `seedAbacusKey` is written into the target so the relaunch is signed in.
 */
export const activateProfile = (
  key: string,
  seedAbacusKey: string | null,
  aliases: readonly string[] = []
): boolean => {
  const registry = readRegistry();

  if (registry.profiles[key] == null) {
    const existingAlias = aliases.find(
      (alias) => registry.profiles[alias] != null
    );
    registry.profiles[key] =
      existingAlias != null
        ? registry.profiles[existingAlias]
        : Object.keys(registry.profiles).length === 0
          ? "."
          : path.join("profiles", key);
  }
  registry.active = key;
  writeRegistry(registry);

  const target = profileDir(registry, key);
  const current = process.env.ABACUSAI_BOT_HOME || BASE;
  if (path.resolve(current) === target) return false;

  fs.mkdirSync(target, { recursive: true });
  if (seedAbacusKey != null && seedAbacusKey.trim().length > 0)
    seedApiKey(target, seedAbacusKey.trim());

  return true;
};

/** Direct merge, not saveApiKey: that writes to the current (wrong) home. */
const seedApiKey = (targetDir: string, apiKey: string): void => {
  const file = path.join(targetDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed != null && typeof parsed === "object")
      config = parsed as Record<string, unknown>;
  } catch {
    // A fresh profile has no config yet.
  }
  const apiKeys =
    config.apiKeys != null && typeof config.apiKeys === "object"
      ? (config.apiKeys as Record<string, string>)
      : {};
  config.apiKeys = { ...apiKeys, ABACUS_API_KEY: apiKey };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
};
