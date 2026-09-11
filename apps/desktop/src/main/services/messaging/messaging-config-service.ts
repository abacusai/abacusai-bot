import fs from "fs";
import path from "path";

import {
  isMessagingPlatformId,
  MESSAGING_PLATFORM_CATALOG,
  messagingPlatformSpec,
  type MessagingPairedUser,
  type MessagingPlatformId,
} from "#shared/messaging";

import { abacusBotHome } from "../../paths";
import { environmentNoticeService } from "../providers/environment-notice-service";

/**
 * Messaging credentials and pairing state: `~/.abacusai-bot/messaging.json`.
 * Not in `config.json`, which is hand-editable and read by the agent
 * subprocess; tokens and the sender allowlist get their own `0600` file. As
 * with provider keys, the environment wins over anything stored here.
 */

type StoredPlatform = {
  enabled?: boolean;
  values?: Record<string, string>;
};

type StoredConfig = {
  gatewayEnabled?: boolean;
  autoApproveTools?: boolean;
  respondToInbound?: boolean;
  workspaceId?: string | null;
  botId?: string | null;
  /** The dedicated bot for the user's OWN chat (the Telegram bootstrap's). */
  selfBotId?: string | null;
  /** Self-lane bots keyed by platform, for platforms that get their own. */
  selfBotIds?: Partial<Record<MessagingPlatformId, string | null>>;
  platforms?: Partial<Record<MessagingPlatformId, StoredPlatform>>;
  pairing?: MessagingPairedUser[];
  /** The one-time Telegram auto-reply bot bootstrap has run. */
  autoReplyBootstrapped?: boolean;
  /** Platforms whose own self-lane bootstrap has run (see selfBotIds). */
  autoReplyBootstrappedFor?: MessagingPlatformId[];
  /** Epoch ms until which the loop breaker holds auto-reply. See the gateway. */
  autoReplyPausedUntil?: number;
};

const configPath = (): string => path.join(abacusBotHome(), "messaging.json");

/**
 * The gateway's recent-traffic log, `~/.abacusai-bot/messaging-log.json`.
 * Its own file: it is rewritten on a timer while messages flow, and
 * credential writes must stay rare. Message contents get the same 0600.
 */
const messageLogPath = (): string =>
  path.join(abacusBotHome(), "messaging-log.json");

export const readStoredMessageLog = (): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(messageLogPath(), "utf8")
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const writeStoredMessageLog = (entries: unknown[]): void => {
  const target = messageLogPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Temp file + rename, chmod before rename — same reasoning as writeConfig.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries)}\n`, "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows and some network filesystems don't implement POSIX modes.
  }
  fs.renameSync(tmp, target);
};

const readConfig = (): StoredConfig => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed != null && typeof parsed === "object"
      ? (parsed as StoredConfig)
      : {};
  } catch {
    return {};
  }
};

const writeConfig = (config: StoredConfig): StoredConfig => {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Temp file + rename, so a torn write cannot leave a truncated file the next
  // reader parses as `{}`, forgetting the allowlist. chmod before the rename
  // (`mode` only applies on creation) so it is never visible with loose modes.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows and some network filesystems don't implement POSIX modes.
  }
  fs.renameSync(tmp, target);
  return config;
};

/** Stored value for one field, with the environment taking precedence. */
export const readFieldValue = (
  platformId: MessagingPlatformId,
  key: string
): string | null => {
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0)
    return fromEnv.trim();

  const stored = readConfig().platforms?.[platformId]?.values?.[key];
  return typeof stored === "string" && stored.trim().length > 0
    ? stored.trim()
    : null;
};

export const isFieldFromEnv = (key: string): boolean => {
  const fromEnv = process.env[key];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0;
};

/** Every field value for a platform, keyed by field key. Absent fields omitted. */
export const readPlatformValues = (
  platformId: MessagingPlatformId
): Record<string, string> => {
  const spec = messagingPlatformSpec(platformId);
  if (spec == null) return {};

  const values: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = readFieldValue(platformId, field.key);
    if (value != null) values[field.key] = value;
  }
  return values;
};

/** True when every required field has a value from somewhere. */
export const isPlatformConfigured = (
  platformId: MessagingPlatformId
): boolean => {
  const spec = messagingPlatformSpec(platformId);
  if (spec == null) return false;

  // A platform with no required fields counts as configured: the catalog, not
  // this function, decides what a platform needs.
  return spec.fields
    .filter((field) => field.required)
    .every((field) => readFieldValue(platformId, field.key) != null);
};

export const isPlatformEnabled = (platformId: MessagingPlatformId): boolean =>
  readConfig().platforms?.[platformId]?.enabled === true;

export const setPlatformEnabled = (
  platformId: MessagingPlatformId,
  enabled: boolean
): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  platforms[platformId] = { ...platforms[platformId], enabled };
  writeConfig({ ...config, platforms });
  // A conversation in progress was told what connectors it has. Pairing changes
  // deliberately do not mark: they are traffic, not a connector-list change.
  environmentNoticeService.markChanged();
};

/**
 * Merge field edits. An empty string clears the stored value — that is how the
 * UI's clear button is expressed, so it must delete rather than store `''`.
 */
export const savePlatformValues = (
  platformId: MessagingPlatformId,
  values: Record<string, string>
): void => {
  const spec = messagingPlatformSpec(platformId);
  if (spec == null) return;

  const known = new Set(spec.fields.map((field) => field.key));
  const config = readConfig();
  const platforms = { ...config.platforms };
  const current = { ...platforms[platformId]?.values };

  for (const [key, raw] of Object.entries(values)) {
    // Keys outside the catalog are ignored: the request comes over IPC, and a
    // renderer bug could otherwise write arbitrary content into a 0600 file.
    if (!known.has(key)) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) delete current[key];
    else current[key] = trimmed;
  }

  platforms[platformId] = { ...platforms[platformId], values: current };
  writeConfig({ ...config, platforms });
  // Credentials are what turn a listed platform into a connected one, so a
  // saved (or cleared) field moves it in or out of the connector list.
  environmentNoticeService.markChanged();
};

export const readGatewaySettings = (): {
  gatewayEnabled: boolean;
  autoApproveTools: boolean;
  respondToInbound: boolean;
  workspaceId: string | null;
  botId: string | null;
  selfBotId: string | null;
  selfBotIds: Partial<Record<MessagingPlatformId, string>>;
  autoReplyBootstrapped: boolean;
  autoReplyBootstrappedFor: MessagingPlatformId[];
  autoReplyPausedUntil: number;
} => {
  const config = readConfig();
  const selfBotIds: Partial<Record<MessagingPlatformId, string>> = {};
  for (const [platform, id] of Object.entries(config.selfBotIds ?? {})) {
    if (isMessagingPlatformId(platform) && typeof id === "string")
      selfBotIds[platform] = id;
  }
  return {
    // Default on: enabling a platform and pasting a token already says so.
    gatewayEnabled: config.gatewayEnabled !== false,
    // Default on: a remote turn has nobody at the keyboard to approve a tool,
    // so gating would stall every message. The pairing allowlist keeps it safe.
    autoApproveTools: config.autoApproveTools !== false,
    // Default off: connecting an account must not make the agent answer people
    // on its own. Inbound is logged; letting it drive turns is the opt-in.
    respondToInbound: config.respondToInbound === true,
    workspaceId:
      typeof config.workspaceId === "string" ? config.workspaceId : null,
    // Deliver inbound into this bot's forever chat, not per-sender sessions.
    botId: typeof config.botId === "string" ? config.botId : null,
    selfBotId: typeof config.selfBotId === "string" ? config.selfBotId : null,
    selfBotIds,
    autoReplyBootstrapped: config.autoReplyBootstrapped === true,
    autoReplyBootstrappedFor: (config.autoReplyBootstrappedFor ?? []).filter(
      isMessagingPlatformId
    ),
    autoReplyPausedUntil:
      typeof config.autoReplyPausedUntil === "number"
        ? config.autoReplyPausedUntil
        : 0,
  };
};

export const saveGatewaySettings = (patch: {
  gatewayEnabled?: boolean;
  autoApproveTools?: boolean;
  respondToInbound?: boolean;
  workspaceId?: string | null;
  botId?: string | null;
  autoReplyBootstrapped?: boolean;
  selfBotId?: string | null;
  /** Merged per key; null clears that platform's slot. */
  selfBotIds?: Partial<Record<MessagingPlatformId, string | null>>;
  /** Added to the stored list, never removed. */
  autoReplyBootstrappedFor?: MessagingPlatformId[];
  autoReplyPausedUntil?: number;
}): void => {
  const config = readConfig();
  const selfBotIds =
    patch.selfBotIds != null
      ? { ...config.selfBotIds, ...patch.selfBotIds }
      : config.selfBotIds;
  const bootstrappedFor =
    patch.autoReplyBootstrappedFor != null
      ? [
          ...new Set([
            ...(config.autoReplyBootstrappedFor ?? []),
            ...patch.autoReplyBootstrappedFor,
          ]),
        ]
      : config.autoReplyBootstrappedFor;
  writeConfig({
    ...config,
    ...(patch.gatewayEnabled != null
      ? { gatewayEnabled: patch.gatewayEnabled }
      : {}),
    ...(patch.autoApproveTools != null
      ? { autoApproveTools: patch.autoApproveTools }
      : {}),
    ...(patch.respondToInbound != null
      ? { respondToInbound: patch.respondToInbound }
      : {}),
    ...(patch.autoReplyBootstrapped != null
      ? { autoReplyBootstrapped: patch.autoReplyBootstrapped }
      : {}),
    ...(patch.workspaceId !== undefined
      ? { workspaceId: patch.workspaceId }
      : {}),
    ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
    ...(patch.selfBotId !== undefined ? { selfBotId: patch.selfBotId } : {}),
    ...(selfBotIds != null ? { selfBotIds } : {}),
    ...(bootstrappedFor != null
      ? { autoReplyBootstrappedFor: bootstrappedFor }
      : {}),
    ...(patch.autoReplyPausedUntil != null
      ? { autoReplyPausedUntil: patch.autoReplyPausedUntil }
      : {}),
  });
};

const readPairing = (): MessagingPairedUser[] => {
  const rows = readConfig().pairing;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is MessagingPairedUser =>
      row != null &&
      typeof row === "object" &&
      isMessagingPlatformId((row as MessagingPairedUser).platform) &&
      typeof (row as MessagingPairedUser).userId === "string"
  );
};

export const listPairing = (): MessagingPairedUser[] => readPairing();

const pairingKey = (platform: MessagingPlatformId, userId: string): string =>
  `${platform}:${userId}`;

export const findPairing = (
  platform: MessagingPlatformId,
  userId: string
): MessagingPairedUser | null =>
  readPairing().find(
    (row) =>
      pairingKey(row.platform, row.userId) === pairingKey(platform, userId)
  ) ?? null;

/**
 * How many senders may be waiting for a decision at once. Re-recording a
 * sender is a no-op, but distinct senders are unbounded, and on email every
 * spam message arrives from a new address: each adds a row and rewrites the
 * file. Oldest pending is evicted first; approved senders are never touched.
 */
const MAX_PENDING_PAIRING = 50;

/**
 * Record an unseen sender as `pending`. Returns the row either way so a caller
 * can tell an approved sender from one awaiting a decision. Re-recording is a
 * no-op: the first message is the one to show when approving, and a chatty
 * stranger must not overwrite it.
 */
export const recordPairingRequest = (input: {
  platform: MessagingPlatformId;
  userId: string;
  userName: string | null;
  chatId: string;
  firstMessage: string | null;
}): MessagingPairedUser => {
  const existing = findPairing(input.platform, input.userId);
  if (existing != null) {
    // The reply address can legitimately move (a user who DMed from a group,
    // a new email thread), so that one field is refreshed.
    if (existing.chatId !== input.chatId) {
      updatePairing(input.platform, input.userId, { chatId: input.chatId });
      return { ...existing, chatId: input.chatId };
    }
    return existing;
  }

  const row: MessagingPairedUser = {
    platform: input.platform,
    userId: input.userId,
    userName: input.userName,
    chatId: input.chatId,
    status: "pending",
    firstSeenAt: new Date().toISOString(),
    firstMessage:
      input.firstMessage != null ? input.firstMessage.slice(0, 500) : null,
  };

  const config = readConfig();
  writeConfig({
    ...config,
    pairing: withinPendingCap([...readPairing(), row]),
  });
  return row;
};

/**
 * Trim the oldest pending rows to the cap, keeping every approved one. Order
 * is otherwise preserved: the pane shows the list as stored, and reshuffling
 * would move rows under someone mid-decision.
 */
const withinPendingCap = (
  rows: MessagingPairedUser[]
): MessagingPairedUser[] => {
  const pending = rows.filter((row) => row.status === "pending");
  if (pending.length <= MAX_PENDING_PAIRING) return rows;

  const doomed = new Set(
    [...pending]
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
      .slice(0, pending.length - MAX_PENDING_PAIRING)
  );

  return rows.filter((row) => !doomed.has(row));
};

const updatePairing = (
  platform: MessagingPlatformId,
  userId: string,
  patch: Partial<MessagingPairedUser>
): void => {
  const config = readConfig();
  const next = readPairing().map((row) =>
    pairingKey(row.platform, row.userId) === pairingKey(platform, userId)
      ? { ...row, ...patch }
      : row
  );
  writeConfig({ ...config, pairing: next });
};

/** Auto-reply keeps the row but stops answering; resume is approvePairing. */
export const pausePairing = (
  platform: MessagingPlatformId,
  userId: string
): void => {
  updatePairing(platform, userId, { status: "paused" });
};

export const approvePairing = (
  platform: MessagingPlatformId,
  userId: string,
  options?: { managedBy?: "bot"; botId?: string }
): void => {
  updatePairing(platform, userId, {
    status: "approved",
    ...(options?.managedBy != null ? { managedBy: options.managedBy } : {}),
    ...(options?.botId != null ? { botId: options.botId } : {}),
  });
};

/**
 * Remove a sender entirely rather than marking them rejected: a tombstone
 * would stop a mistaken revoke from ever re-pairing, and give the pane a
 * third state to explain. Their next message just opens a fresh request.
 */
export const revokePairing = (
  platform: MessagingPlatformId,
  userId: string
): void => {
  const config = readConfig();
  const next = readPairing().filter(
    (row) =>
      pairingKey(row.platform, row.userId) !== pairingKey(platform, userId)
  );
  writeConfig({ ...config, pairing: next });
};

/** Approved senders for a platform, used by connectors to gate inbound traffic. */
export const approvedUserIds = (platform: MessagingPlatformId): Set<string> =>
  new Set(
    readPairing()
      .filter((row) => row.platform === platform && row.status === "approved")
      .map((row) => row.userId)
  );

/** Every platform in the catalog that is both enabled and has its credentials. */
export const runnablePlatformIds = (): MessagingPlatformId[] =>
  MESSAGING_PLATFORM_CATALOG.filter(
    (entry) => isPlatformEnabled(entry.id) && isPlatformConfigured(entry.id)
  ).map((entry) => entry.id);
