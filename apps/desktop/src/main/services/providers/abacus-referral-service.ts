import crypto from "crypto";

import type {
  ReferralGmailContact,
  ReferralInviteOutcome,
  ReferralSummary,
} from "#shared/contracts";

import {
  abacusApiCall,
  listAbacusConnectors,
} from "./abacus-connector-service";

/**
 * The invite-friends loop. The platform owns the referral code, the email
 * sends and the credit grant; this app only picks recipients with the user
 * and, for WhatsApp, delivers from their own number and reports what went out.
 */

/** The platform's per-request cap on invites. */
export const REFERRAL_INVITE_BATCH = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX_CHARS = 1000;

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const stringOr = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const cleanMessage = (message: unknown): string =>
  (typeof message === "string" ? message : "")
    .trim()
    .slice(0, MESSAGE_MAX_CHARS);

/** Distinct, well-formed, lower-cased, capped at the platform's batch. */
export const cleanEmails = (emails: unknown): string[] => {
  if (!Array.isArray(emails)) return [];
  const seen = new Set<string>();
  for (const value of emails) {
    if (typeof value !== "string") continue;
    const email = value.trim().toLowerCase();
    if (EMAIL_RE.test(email)) seen.add(email);
    if (seen.size >= REFERRAL_INVITE_BATCH) break;
  }
  return [...seen];
};

const cleanChatIds = (chatIds: unknown): string[] => {
  if (!Array.isArray(chatIds)) return [];
  const seen = new Set<string>();
  for (const value of chatIds) {
    if (typeof value !== "string") continue;
    const chatId = value.trim();
    if (chatId.length > 0) seen.add(chatId);
    if (seen.size >= REFERRAL_INVITE_BATCH) break;
  }
  return [...seen];
};

/**
 * What the platform learns about a WhatsApp recipient: a truncated hash of
 * the chat name, enough to count each person once and nothing more.
 */
export const whatsappRecipientId = (chatId: string): string =>
  crypto
    .createHash("sha256")
    .update(chatId.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);

const outcome = (
  partial: Partial<ReferralInviteOutcome>
): ReferralInviteOutcome => ({
  ok: false,
  sent: 0,
  skipped: 0,
  failed: 0,
  invitesSent: null,
  milestoneCreditsGranted: 0,
  error: null,
  ...partial,
});

const countOf = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

export const fetchReferralSummary =
  async (): Promise<ReferralSummary | null> => {
    const [summary, connectors] = await Promise.all([
      abacusApiCall("_getFreeTierReferralSummary", "POST", {}),
      listAbacusConnectors(),
    ]);
    if (
      !summary.ok ||
      summary.result == null ||
      typeof summary.result !== "object"
    )
      return null;
    const row = summary.result as Record<string, unknown>;
    const inviteLink = stringOr(row.botInviteLink);
    if (inviteLink == null) return null;
    return {
      inviteLink,
      invitesSent: numberOr(row.invitesSent, 0),
      milestoneInvites: numberOr(row.milestoneInvites, REFERRAL_INVITE_BATCH),
      milestoneCredits: numberOr(row.milestoneCredits, 0),
      milestoneGranted: row.milestoneGranted === true,
      friendsJoined: numberOr(row.friendsJoined, 0),
      creditsPerFriend: numberOr(row.creditsPerFriend, 0),
      gmailConnected: connectors.connected.gmailuser != null,
    };
  };

export const listReferralGmailContacts = async (): Promise<
  ReferralGmailContact[]
> => {
  const { ok, result } = await abacusApiCall("_listGmailTopContacts", "GET", {
    limit: REFERRAL_INVITE_BATCH,
  });
  if (!ok || !Array.isArray(result)) return [];
  const contacts: ReferralGmailContact[] = [];
  const seen = new Set<string>();
  for (const row of result) {
    if (row == null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const email = stringOr(record.email)?.trim().toLowerCase();
    if (email == null || !EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    contacts.push({ email, name: stringOr(record.name) });
  }
  return contacts;
};

/**
 * Email invites go out from the user's own Gmail when it is connected, else
 * from the platform's referrals address; either way the platform writes the
 * rows that count toward the milestone.
 */
export const sendReferralEmailInvites = async (
  emails: unknown,
  message: unknown
): Promise<ReferralInviteOutcome> => {
  const list = cleanEmails(emails);
  if (list.length === 0) return outcome({ ok: true });
  const connectors = await listAbacusConnectors();
  if (!connectors.ok && connectors.error === "not-signed-in")
    return outcome({ error: "not-signed-in" });
  const { ok, result } = await abacusApiCall("_referUsersToChatLLM", "POST", {
    emails: list,
    message: cleanMessage(message) || undefined,
    sendViaGmail: connectors.connected.gmailuser != null,
    botInvite: true,
  });
  if (!ok || result == null || typeof result !== "object")
    return outcome({ failed: list.length, error: "unavailable" });
  const row = result as Record<string, unknown>;
  return outcome({
    ok: true,
    sent: countOf(row.successfulInvites),
    skipped: countOf(row.userAlreadyExists),
    failed: countOf(row.failedToSend),
    invitesSent: typeof row.invitesSent === "number" ? row.invitesSent : null,
    milestoneCreditsGranted: numberOr(row.milestoneCreditsGranted, 0),
  });
};

/**
 * WhatsApp invites are delivered here, one chat at a time from the user's own
 * number, then reported to the platform as opaque recipient ids.
 */
export const sendReferralWhatsappInvites = async (
  chatIds: unknown,
  message: unknown,
  send: (chatId: string, text: string) => Promise<void>
): Promise<ReferralInviteOutcome> => {
  const list = cleanChatIds(chatIds);
  if (list.length === 0) return outcome({ ok: true });
  const summary = await fetchReferralSummary();
  if (summary == null) return outcome({ error: "not-signed-in" });
  const text = `${cleanMessage(message)}\n\n${summary.inviteLink}`.trim();
  const delivered: string[] = [];
  let failed = 0;
  for (const chatId of list) {
    try {
      await send(chatId, text);
      delivered.push(chatId);
    } catch (error) {
      failed += 1;
      console.warn(
        `[referrals] WhatsApp invite failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (delivered.length === 0)
    return outcome({ failed, error: "whatsapp-not-connected" });
  const { ok, result } = await abacusApiCall(
    "_recordWhatsappReferralInvites",
    "POST",
    { recipientIds: delivered.map(whatsappRecipientId) }
  );
  const row =
    ok && result != null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
  const newInvites = numberOr(row?.newInvites, delivered.length);
  return outcome({
    ok: true,
    sent: newInvites,
    skipped: delivered.length - newInvites,
    failed,
    invitesSent: typeof row?.invitesSent === "number" ? row.invitesSent : null,
    milestoneCreditsGranted: numberOr(row?.milestoneCreditsGranted, 0),
  });
};
