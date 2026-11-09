import fs from "fs";
import path from "path";

import {
  recoverFromBackupSync,
  writeFileAtomicSync,
} from "@abacus-ai/agent/atomic-file";
import {
  isMessagingPlatformId,
  messagingPlatformSpec,
  type MessagingChatKind,
  type MessagingPairedUser,
  type MessagingPlatformId,
} from "@abacus-ai/contract/messaging";

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
  /** A web-login platform's last sign-in verdict; absent until first seen. */
  signedIn?: boolean;
  /** The link it had ended, and no new one replaced it yet. */
  linkLost?: boolean;
  /**
   * The app stopped it (a login left unfinished), apart from the user's own
   * `enabled`: it stays on, is not started again, and Connect resumes it.
   */
  appStopped?: "login-not-finished" | null;
};

type StoredConfig = {
  gatewayEnabled?: boolean;
  autoApproveTools?: boolean;
  respondToInbound?: boolean;
  /** Answer anyone writing one to one, without approving each. */
  answerPrivateChats?: boolean;
  workspaceId?: string | null;
  botId?: string | null;
  /** The retired own-account Telegram bootstrap's self bot; kept as written. */
  selfBotId?: string | null;
  /** Each self lane's home bot (see BotService.setHomeBot), by lane. */
  selfBotIds?: Partial<Record<MessagingPlatformId, string | null>>;
  platforms?: Partial<Record<MessagingPlatformId, StoredPlatform>>;
  pairing?: MessagingPairedUser[];
  /** The retired own-account Telegram bootstrap ran; kept as written. */
  autoReplyBootstrapped?: boolean;
  /** Self lanes whose default home bot was set, once ever (see selfBotIds). */
  autoReplyBootstrappedFor?: MessagingPlatformId[];
  /** Epoch ms until which the loop breaker holds auto-reply. See the gateway. */
  autoReplyPausedUntil?: number;
  /** The last one-time upgrade applied (see `upgradeConfig`); absent before any. */
  configVersion?: number;
};

/** Bump with each new step in `upgradeConfig`. */
export const MESSAGING_CONFIG_VERSION = 2;

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

const outboxPath = (): string =>
  path.join(abacusBotHome(), "messaging-outbox.json");

/** Chat messages still owed (ChatOutbox): its file as it was last written. */
export const readStoredOutbox = (): unknown => {
  try {
    return JSON.parse(fs.readFileSync(outboxPath(), "utf8"));
  } catch {
    return null;
  }
};

export const writeStoredOutbox = (state: unknown): void => {
  writeFileAtomicSync(outboxPath(), `${JSON.stringify(state)}\n`, {
    restrict: true,
  });
};

const seenPath = (): string =>
  path.join(abacusBotHome(), "messaging-seen.json");

/** What each lane last saw (InboundWatermark): its file as last written. */
export const readStoredSeen = (): unknown => {
  try {
    return JSON.parse(fs.readFileSync(seenPath(), "utf8"));
  } catch {
    return null;
  }
};

export const writeStoredSeen = (state: unknown): void => {
  writeFileAtomicSync(seenPath(), `${JSON.stringify(state)}\n`, {
    restrict: true,
  });
};

export const writeStoredMessageLog = (entries: unknown[]): void => {
  writeFileAtomicSync(messageLogPath(), `${JSON.stringify(entries)}\n`, {
    restrict: true,
  });
};

/** The config `text` holds, or null when it is not a JSON object. */
const parseConfig = (text: string): StoredConfig | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed != null && typeof parsed === "object"
      ? (parsed as StoredConfig)
      : null;
  } catch {
    return null;
  }
};

/**
 * A file whose bytes do not parse (a crash can leave it NUL-filled) is put
 * back from its last good copy rather than read as `{}`, which the next save
 * would write over the allowlist and tokens it held.
 */
const readConfig = (): StoredConfig => {
  let text: string;
  try {
    text = fs.readFileSync(configPath(), "utf8");
  } catch {
    // A new install has nothing to upgrade: its first save is current.
    return { configVersion: MESSAGING_CONFIG_VERSION };
  }
  const parsed = parseConfig(text);
  if (parsed !== null) return upgradeConfig(parsed);
  const restored = recoverFromBackupSync(
    configPath(),
    (backup) => parseConfig(backup) !== null,
    { restrict: true }
  );
  if (restored === null) return { configVersion: MESSAGING_CONFIG_VERSION };
  console.warn(
    "[messaging] messaging config did not parse; restored it from its last good copy"
  );
  return upgradeConfig(parseConfig(restored) ?? {});
};

/** WhatsApp's self chat was found once, or someone wrote in on it: it was linked. */
const whatsAppLinkedOnce = (config: StoredConfig): boolean =>
  (config.autoReplyBootstrappedFor ?? []).includes("whatsapp") ||
  (Array.isArray(config.pairing) &&
    config.pairing.some((row) => row?.platform === "whatsapp"));

/**
 * v1: a WhatsApp link that ended on an app from before `linkLost` saved only
 * `signedIn: false`, so the lane never said it was lost. A lane the user
 * unlinked is off, and one never linked has no evidence: both stay.
 */
const markLinkLostBeforeFlag = (config: StoredConfig): StoredConfig => {
  const whatsapp = config.platforms?.whatsapp;
  const lostBeforeFlag =
    whatsapp?.enabled === true &&
    whatsapp.signedIn === false &&
    whatsapp.linkLost === undefined &&
    whatsAppLinkedOnce(config);
  if (!lostBeforeFlag) return config;
  return {
    ...config,
    platforms: {
      ...config.platforms,
      whatsapp: { ...whatsapp, linkLost: true },
    },
  };
};

/** The shared lanes' id for the user's own chat (abacus-channels-connector). */
const SHARED_LANE_SELF_ID = "me";

/**
 * v2: take back what the old rule approved. It approved every sender seen
 * while auto-reply was off, so switching on answered all of them. Rows a bot
 * was told to answer, and the user's own chat, stay. Off, nobody is answered
 * yet, so the rest wait for the user again; on, they are marked, and the
 * gateway answers none of them until the user approves each again.
 */
const takeBackAutoApprovals = (config: StoredConfig): StoredConfig => {
  if (!Array.isArray(config.pairing)) return config;
  const on = config.respondToInbound === true;
  return {
    ...config,
    pairing: config.pairing.map((row): MessagingPairedUser => {
      if (
        row?.status !== "approved" ||
        row.managedBy === "bot" ||
        row.userId === SHARED_LANE_SELF_ID
      )
        return row;
      return on
        ? { ...row, autoAdded: true }
        : { ...row, status: "pending", autoAdded: true };
    }),
  };
};

/** Set once the read path has tried to save an upgrade; see `upgradeConfig`. */
let upgradeSaveTried = false;

/**
 * One-time upgrades of a config an older app wrote: each step runs only on a
 * config older than its own number, then the current version is stamped.
 */
const upgradeConfig = (config: StoredConfig): StoredConfig => {
  const from = config.configVersion ?? 0;
  if (from >= MESSAGING_CONFIG_VERSION) return config;
  let upgraded = config;
  if (from < 1) upgraded = markLinkLostBeforeFlag(upgraded);
  if (from < 2) upgraded = takeBackAutoApprovals(upgraded);
  upgraded = { ...upgraded, configVersion: MESSAGING_CONFIG_VERSION };
  // Saved from a read at most once per run; any later save stores it anyway.
  if (upgradeSaveTried) return upgraded;
  upgradeSaveTried = true;
  try {
    return writeConfig(upgraded);
  } catch (error) {
    // A read must not fail on the save (a read-only or full disk).
    console.warn("[messaging] messaging config upgrade not saved:", error);
    return upgraded;
  }
};

const writeConfig = (config: StoredConfig): StoredConfig => {
  // Atomic, so a torn write cannot leave a truncated file the next reader
  // parses as `{}`, forgetting the allowlist; kept twice so a copy a crash
  // tore can be put back (`readConfig`).
  writeFileAtomicSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    restrict: true,
    keepBackup: true,
  });
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

/** Why the app stopped this lane, if it did; see `appStopped`. */
export const readPlatformAppStopped = (
  platformId: MessagingPlatformId
): "login-not-finished" | null =>
  readConfig().platforms?.[platformId]?.appStopped ?? null;

export const savePlatformAppStopped = (
  platformId: MessagingPlatformId,
  reason: "login-not-finished" | null
): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  platforms[platformId] = { ...platforms[platformId], appStopped: reason };
  writeConfig({ ...config, platforms });
};

export const setPlatformEnabled = (
  platformId: MessagingPlatformId,
  enabled: boolean
): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  // Switched by hand either way: whatever the app had stopped is the user's again.
  platforms[platformId] = {
    ...platforms[platformId],
    enabled,
    appStopped: null,
  };
  writeConfig({ ...config, platforms });
  // A conversation in progress was told what connectors it has. Pairing changes
  // deliberately do not mark: they are traffic, not a connector-list change.
  environmentNoticeService.markChanged();
};

/** Null when never recorded, e.g. an install from before the record. */
export const readPlatformSignedIn = (
  platformId: MessagingPlatformId
): boolean | null => {
  const signedIn = readConfig().platforms?.[platformId]?.signedIn;
  return typeof signedIn === "boolean" ? signedIn : null;
};

export const savePlatformSignedIn = (
  platformId: MessagingPlatformId,
  signedIn: boolean
): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  platforms[platformId] = {
    ...platforms[platformId],
    signedIn,
    // Signed in again: whatever was lost is back.
    ...(signedIn ? { linkLost: false } : {}),
  };
  writeConfig({ ...config, platforms });
};

/** The user ended the link: signed out, and nothing was lost to tell them about. */
export const savePlatformUnlinked = (platformId: MessagingPlatformId): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  platforms[platformId] = {
    ...platforms[platformId],
    signedIn: false,
    linkLost: false,
  };
  writeConfig({ ...config, platforms });
};

export const readPlatformLinkLost = (
  platformId: MessagingPlatformId
): boolean => readConfig().platforms?.[platformId]?.linkLost === true;

/** A link that worked has ended; signing in again clears it. */
export const savePlatformLinkLost = (platformId: MessagingPlatformId): void => {
  const config = readConfig();
  const platforms = { ...config.platforms };
  platforms[platformId] = { ...platforms[platformId], linkLost: true };
  writeConfig({ ...config, platforms });
};

/**
 * Merge field edits. An empty string clears the stored value: that is how the
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
  answerPrivateChats: boolean;
  workspaceId: string | null;
  botId: string | null;
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
    // Default off: each person is the user's to approve.
    answerPrivateChats: config.answerPrivateChats === true,
    workspaceId:
      typeof config.workspaceId === "string" ? config.workspaceId : null,
    // Deliver inbound into this bot's forever chat, not per-sender sessions.
    botId: typeof config.botId === "string" ? config.botId : null,
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
  answerPrivateChats?: boolean;
  workspaceId?: string | null;
  botId?: string | null;
  autoReplyBootstrapped?: boolean;
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
    ...(patch.answerPrivateChats != null
      ? { answerPrivateChats: patch.answerPrivateChats }
      : {}),
    ...(patch.autoReplyBootstrapped != null
      ? { autoReplyBootstrapped: patch.autoReplyBootstrapped }
      : {}),
    ...(patch.workspaceId !== undefined
      ? { workspaceId: patch.workspaceId }
      : {}),
    ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
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
  kind?: MessagingChatKind;
}): MessagingPairedUser => {
  const existing = findPairing(input.platform, input.userId);
  if (existing != null) {
    // The reply address can legitimately move (a user who DMed from a group,
    // a new email thread), and the kind arrives once the platform knows it.
    const patch: Partial<MessagingPairedUser> = {
      ...(existing.chatId !== input.chatId ? { chatId: input.chatId } : {}),
      ...(input.kind != null && existing.kind !== input.kind
        ? { kind: input.kind }
        : {}),
    };
    if (Object.keys(patch).length === 0) return existing;
    updatePairing(input.platform, input.userId, patch);
    return { ...existing, ...patch };
  }

  const row: MessagingPairedUser = {
    platform: input.platform,
    userId: input.userId,
    userName: input.userName,
    chatId: input.chatId,
    status: "pending",
    ...(input.kind != null ? { kind: input.kind } : {}),
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
 * Trim the oldest pending rows to the cap, keeping every approved one and the
 * rows the migration took back, which wait for the user's decision. Order
 * is otherwise preserved: the pane shows the list as stored, and reshuffling
 * would move rows under someone mid-decision.
 */
const withinPendingCap = (
  rows: MessagingPairedUser[]
): MessagingPairedUser[] => {
  const pending = rows.filter(
    (row) => row.status === "pending" && row.autoAdded !== true
  );
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
    // The user's own decision now; the old rule's marker no longer applies.
    autoAdded: undefined,
    ...(options?.managedBy != null ? { managedBy: options.managedBy } : {}),
    ...(options?.botId != null ? { botId: options.botId } : {}),
  });
};

/** The user was told this chat is waiting (the gateway tells each once). */
export const markPairingTold = (
  platform: MessagingPlatformId,
  userId: string
): void => {
  updatePairing(platform, userId, { toldAt: new Date().toISOString() });
};

/** Back to waiting for the user: a row the old rule approved, seen in a group. */
export const holdPairing = (
  platform: MessagingPlatformId,
  userId: string
): void => {
  updatePairing(platform, userId, { status: "pending" });
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
