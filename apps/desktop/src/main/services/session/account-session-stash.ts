import crypto from "crypto";
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

/**
 * Where a signed-out account's sessions wait for its next sign-in: records
 * move to `~/.abacusai-bot/accounts/<key>/sessions.json` and back; transcripts
 * stay put, unreachable without a record. The key hashes the email (or the
 * credential) so the tree never names anyone and two accounts stay apart.
 */

const ACCOUNTS_DIR = "accounts";
const STASH_FILE = "sessions.json";

export const FALLBACK_ACCOUNT_KEY = "default";

const hashed = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

export const accountStashKey = (
  email: string | null | undefined,
  /** The credential in force, hashed when there is no email to key on. */
  apiKey?: string | null
): string => {
  const normalized = email?.trim().toLowerCase();
  if (normalized != null && normalized.length > 0) return hashed(normalized);

  // Namespaced so a key-derived folder never collides with an email-derived
  // one.
  const key = apiKey?.trim();

  return key != null && key.length > 0
    ? `key-${hashed(key)}`
    : FALLBACK_ACCOUNT_KEY;
};

const stashPath = (accountKey: string): string =>
  path.join(abacusBotHome(), ACCOUNTS_DIR, accountKey, STASH_FILE);

/** The stashed records, or [] when the account has no stash. */
export const readSessionStash = (accountKey: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(stashPath(accountKey), "utf8")
    );
    const records = (parsed as { records?: unknown })?.records;

    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
};

export const writeSessionStash = (
  accountKey: string,
  records: unknown[]
): void => {
  const file = stashPath(accountKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ records }, null, 2), {
    mode: 0o600,
  });
};

/** Remove a restored stash so the same sessions cannot be restored twice. */
export const clearSessionStash = (accountKey: string): void => {
  try {
    fs.rmSync(stashPath(accountKey), { force: true });
  } catch {
    // Restore merges by id, so a stash left behind costs work, not duplicates.
  }
};
