/**
 * A WhatsApp chat moved from the bot to a personal agent of the user's own
 * (the server's `agent_handover` step event). The bot hands that agent what
 * it knows of its owner, once: the "about you" notes and the user's custom
 * instructions. It is never a turn and never a word to the user; the chat is
 * no longer the bot's.
 */
import { readCustomInstructions } from "@abacus-ai/agent/custom-instructions";
import {
  listNotes,
  looksSecret,
  type Note,
  today,
} from "@abacus-ai/agent/memory";

import { hasKey } from "../diagnostics/scrub";
import { resolveAbacusApiKey } from "../providers/abacus";
import { abacusRoutellmV1, abacusUserAgent } from "../providers/abacus-host";

/** The server's caps; anything longer would be cut there anyway. */
const HANDOVER_MEMORY_CHARS = 8_000;
const HANDOVER_INSTRUCTIONS_CHARS = 2_000;

/** Waits before each retry: a network error or a server error. */
const RETRY_DELAYS_MS = [2_000, 6_000];
const TIMEOUT_MS = 10_000;

export interface HandoverPayload {
  memory: string;
  instructions: string;
}

export type HandoverOutcome =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean };

/** A line that holds a key, a token or a password never leaves. */
const safeLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !looksSecret(line) && !hasKey(line));

/** One note as plain text: its line, then its body, secrets dropped. */
const noteText = (note: Note): string => {
  const lines = safeLines(note.body.trim());
  const head = safeLines(note.description.trim())[0] ?? "";
  return [
    `[${note.type}${note.updated ? `, ${note.updated}` : ""}] ${head}`.trim(),
    ...lines.filter((line) => line.trim().length > 0),
  ].join("\n");
};

/**
 * The owner's memory as plain text, newest first, capped. Rules are left
 * out: they are the custom instructions, sent on their own. A status note
 * past its date is stale and stays behind.
 */
export const ownerMemoryText = (
  notes: readonly Note[],
  now = new Date(),
  max = HANDOVER_MEMORY_CHARS
): string => {
  const day = today(now);
  const kept: string[] = [];
  let used = 0;
  const newest = notes
    .filter((note) => note.type !== "rule" && note.type !== "card")
    .filter((note) => note.expires == null || note.expires >= day)
    .sort((a, b) => b.updated.localeCompare(a.updated));
  for (const note of newest) {
    const text = noteText(note);
    const cost = text.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > max) continue;
    kept.push(text);
    used += cost;
  }
  return kept.join("\n\n");
};

/** The custom instructions, secrets dropped, cut at a line under the cap. */
export const instructionsText = (
  text: string,
  max = HANDOVER_INSTRUCTIONS_CHARS
): string => {
  const kept: string[] = [];
  let used = 0;
  for (const line of safeLines(text.trim())) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > max) break;
    kept.push(line);
    used += cost;
  }
  return kept.join("\n").trim();
};

/** What the new agent is sent; memory is empty when the user turned it off. */
export const handoverPayload = (
  memoryOn: boolean,
  now = new Date()
): HandoverPayload => ({
  memory: memoryOn ? ownerMemoryText(listNotes({ kind: "you" }), now) : "",
  instructions: instructionsText(readCustomInstructions()),
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs the payload. 404 (no agent took the chat) and 403 (a wrong key) are
 * the server's final answer; a network or server error is tried again. The
 * server keeps the first copy, so a retry is safe.
 */
export async function postHandoverMemory(
  payload: HandoverPayload,
  options: {
    url?: string;
    key?: string | null;
    fetchImpl?: typeof fetch;
    delaysMs?: readonly number[];
  } = {}
): Promise<HandoverOutcome> {
  const key = (options.key ?? resolveAbacusApiKey() ?? "").trim();
  if (key.length === 0)
    return { ok: false, reason: "no-key", retryable: false };
  const url =
    options.url ?? `${abacusRoutellmV1()}/abacusaibot_handover_memory`;
  const doFetch = options.fetchImpl ?? fetch;
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  let outcome: HandoverOutcome = {
    ok: false,
    reason: "not-sent",
    retryable: true,
  };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1]!);
    outcome = await postOnce(doFetch, url, key, payload);
    if (outcome.ok === true || !outcome.retryable) return outcome;
  }
  return outcome;
}

async function postOnce(
  doFetch: typeof fetch,
  url: string,
  key: string,
  payload: HandoverPayload
): Promise<HandoverOutcome> {
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "user-agent": abacusUserAgent(),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };
    return {
      ok: false,
      reason: `http-${response.status}`,
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.name : "network",
      retryable: true,
    };
  }
}

/** Reads, sends and logs the outcome; never throws. */
export async function handOverMemory(
  memoryOn: boolean,
  log: (line: string) => void
): Promise<HandoverOutcome> {
  let payload: HandoverPayload;
  try {
    payload = handoverPayload(memoryOn);
  } catch (error) {
    log(
      `[handover] memory not read: ${error instanceof Error ? error.message : String(error)}`
    );
    // An empty copy would be the one the server keeps: send nothing instead.
    return { ok: false, reason: "unreadable", retryable: false };
  }
  const outcome = await postHandoverMemory(payload);
  log(
    outcome.ok === true
      ? `[handover] memory sent (${payload.memory.length} chars, instructions ${payload.instructions.length} chars)`
      : `[handover] memory not sent: ${outcome.reason}`
  );
  return outcome;
}
