/**
 * Admission (spec 02 §3.7): `ai.send` outside `ChatClient`, with an outbox
 * of pending user messages in the host store. A pending message is shown
 * until the agent's echo of its id is processed; RPC outcomes that arrive
 * after the echo are ignored. Definitive failures remove the entry;
 * uncertain ones keep it and re-send the same run id and message id
 * (main answers a repeat with the recorded original ack, §14.5).
 */
import type { UIMessage } from "@tanstack/ai-client";

import { isDefinitive, type AiClient } from "#next/data/ai";
import type { AiSendAck } from "#shared/contract/ai";

type OutboxState = "sending" | "accepted" | "unconfirmed" | "failed";

export interface OutboxEntry {
  id: string;
  runId: string;
  text: string;
  createdAt: number;
  state: OutboxState;
  attempts: number;
  forwardedProps?: Record<string, unknown>;
  retry?: boolean;
}

type AdmissionKind =
  | "started"
  | "queued"
  | "rejected"
  | "duplicate"
  | "unconfirmed"
  | "stale";

export interface AdmissionResult {
  kind: AdmissionKind;
  reason?: string;
}

/** What admission needs from the session. */
export interface AdmissionHost {
  readonly ai: AiClient;
  readonly threadId: string;
  /** The generation and reset revision, to detect a stale outcome. */
  token(): { gen: number; rev: number; retired?: boolean };
  outbox(): readonly OutboxEntry[];
  setOutbox(update: (outbox: OutboxEntry[]) => OutboxEntry[]): void;
  /** The echo of this message id was processed. */
  echoed(messageId: string, runId?: string): boolean;
  /** Re-send delays for an uncertain admission. */
  readonly reconcileDelaysMs: readonly number[];
  schedule(ms: number, run: () => void): void;
  newId(prefix: "u" | "run"): string;
}

export const RECONCILE_DELAYS_MS = [1000, 3000] as const;

const userMessage = (entry: OutboxEntry) => ({
  id: entry.id,
  role: "user" as const,
  parts: [{ type: "text", content: entry.text }],
});

const patch = (
  host: AdmissionHost,
  id: string,
  change: Partial<OutboxEntry>
): void =>
  host.setOutbox((outbox) =>
    outbox.map((entry) => (entry.id === id ? { ...entry, ...change } : entry))
  );

const remove = (host: AdmissionHost, id: string): void =>
  host.setOutbox((outbox) => outbox.filter((entry) => entry.id !== id));

const find = (host: AdmissionHost, id: string): OutboxEntry | undefined =>
  host.outbox().find((entry) => entry.id === id);

const statusOf = (
  ack: AiSendAck
): Exclude<AdmissionKind, "unconfirmed" | "stale" | "duplicate"> =>
  ack.status === "duplicate" ? (ack.original ?? "started") : ack.status;

const admit = async (
  host: AdmissionHost,
  entryId: string
): Promise<AdmissionResult> => {
  const entry = find(host, entryId);
  if (entry == null) return { kind: "stale" };
  const { rev, retired } = host.token();
  if (retired) return { kind: "stale" };
  const attempts = entry.attempts + 1;
  patch(host, entryId, {
    attempts,
    state: entry.state === "failed" ? "sending" : entry.state,
  });
  const stale = (): boolean => {
    const now = host.token();
    return now.retired === true || now.rev !== rev;
  };
  let ack: AiSendAck;
  try {
    ack = await host.ai.send({
      threadId: host.threadId,
      runId: entry.runId,
      messages: [userMessage(entry)],
      ...(entry.forwardedProps != null
        ? { forwardedProps: entry.forwardedProps }
        : {}),
    });
  } catch (error) {
    if (stale()) return { kind: "stale" };
    if (host.echoed(entryId, entry.retry ? entry.runId : undefined))
      return { kind: "started" };
    if (isDefinitive(error)) {
      remove(host, entryId);
      throw error;
    }
    patch(host, entryId, { state: "unconfirmed" });
    scheduleReconcile(host, entryId, attempts);
    return { kind: "unconfirmed" };
  }
  if (stale()) return { kind: "stale" };
  if (host.echoed(entryId, entry.retry ? entry.runId : undefined))
    return { kind: "started" };
  const status = statusOf(ack);
  if (status === "queued" || status === "rejected") remove(host, entryId);
  else patch(host, entryId, { state: "accepted" });
  return {
    kind: ack.status === "duplicate" ? status : ack.status,
    ...(ack.reason != null ? { reason: ack.reason } : {}),
  };
};

/**
 * Uncertain delivery: re-send the same ids after 1 s and 3 s unless the
 * echo confirmed it; after two failed re-sends the entry is `failed`.
 */
const scheduleReconcile = (
  host: AdmissionHost,
  entryId: string,
  attempts: number
): void => {
  const token = host.token();
  if (token.retired) return;
  const resend = attempts - 1;
  const delay = host.reconcileDelaysMs[resend];
  if (delay == null) {
    patch(host, entryId, { state: "failed" });
    return;
  }
  host.schedule(delay, () => {
    const now = host.token();
    if (now.retired || now.rev !== token.rev) return;
    const entry = find(host, entryId);
    if (
      entry == null ||
      host.echoed(entryId, entry.retry ? entry.runId : undefined)
    )
      return;
    void admit(host, entryId).catch(() => {
      // Definitive on a re-send: the entry is already gone.
    });
  });
};

export const submit = (
  host: AdmissionHost,
  text: string,
  forwardedProps?: Record<string, unknown>,
  messageId?: string
): { entry: OutboxEntry; result: Promise<AdmissionResult> } => {
  const entry: OutboxEntry = {
    id: messageId ?? host.newId("u"),
    runId: host.newId("run"),
    text,
    createdAt: Date.now(),
    state: "sending",
    attempts: 0,
    ...(messageId != null ? { retry: true } : {}),
    ...(forwardedProps != null ? { forwardedProps } : {}),
  };
  if (host.token().retired)
    return { entry, result: Promise.resolve({ kind: "stale" }) };
  host.setOutbox((outbox) => [...outbox, entry]);
  return { entry, result: admit(host, entry.id) };
};

/** "Not sent" → Retry: another admission with the same ids. */
export const retryEntry = (
  host: AdmissionHost,
  entryId: string
): Promise<AdmissionResult> => {
  patch(host, entryId, { state: "sending" });
  return admit(host, entryId);
};

/** "Not sent" → Discard: the entry leaves; the caller restores the draft. */
export const discardEntry = (
  host: AdmissionHost,
  entryId: string
): OutboxEntry | undefined => {
  const entry = find(host, entryId);
  remove(host, entryId);
  return entry;
};

/**
 * The client's messages plus each outbox entry the client does not have yet,
 * as a pending user message (§3.7).
 */
export const withOutbox = (
  messages: readonly UIMessage[],
  outbox: readonly OutboxEntry[]
): UIMessage[] => {
  if (outbox.length === 0) return messages as UIMessage[];
  const ids = new Set(messages.map((message) => message.id));
  const pending = outbox
    .filter((entry) => !ids.has(entry.id))
    .map((entry): UIMessage => ({
      id: entry.id,
      role: "user",
      parts: [{ type: "text", content: entry.text }],
      createdAt: new Date(entry.createdAt),
      metadata: { abacus: { pending: true, state: entry.state } },
    }));
  return pending.length === 0
    ? (messages as UIMessage[])
    : [...messages, ...pending];
};
