/**
 * What routine runs have sent, per fire and recipient, so one fire reaches
 * a person once: a second run for the same fire, or the same text again
 * from one run, is skipped at the send tool (and said so), rather than left
 * to the model. Kept on disk, so a run made up after the app closed under
 * the first one never sends again what that one sent. Connector actions
 * (mail, posts, invites) run in the agent, past this guard: a make-up is told
 * them from the cut-off run's thread instead (`connectorActionsOf`).
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import { UNATTENDED_CONNECTOR_READS } from "@abacus-ai/agent/tool-policy";
import { connectorToolMetaByName } from "@abacus-ai/connectors/tool-meta";

interface Sent {
  platform: string;
  to: string;
  sessionId: string;
  /** Digests of the normalized messages: compared, never read back. */
  messages: string[];
  at: number;
}

/** Long past any fire a run could still be answering. */
const KEPT_MS = 48 * 60 * 60_000;

const normalize = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

const digest = (message: string): string =>
  crypto.createHash("sha256").update(normalize(message)).digest("hex");

export interface RoutineSendLedgerOptions {
  now?: () => number;
  /** The file the sends are kept in across restarts; null keeps none. */
  file?: (() => string) | null;
}

export class RoutineSendLedger {
  private sentByKey: Map<string, Sent> | null = null;

  constructor(private readonly options: RoutineSendLedgerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private key(fire: string, platform: string, to: string): string {
    return [fire, platform, normalize(to)].join("\u0000");
  }

  /** Read once from disk; a missing or unreadable file is nothing sent. */
  private get sent(): Map<string, Sent> {
    if (this.sentByKey != null) return this.sentByKey;
    this.sentByKey = new Map();
    const file = this.options.file?.();
    if (file == null) return this.sentByKey;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed))
        for (const [key, entry] of parsed as Array<[string, Sent]>)
          if (typeof key === "string" && Array.isArray(entry?.messages))
            this.sentByKey.set(key, entry);
    } catch {
      // Nothing kept yet.
    }
    return this.sentByKey;
  }

  /**
   * The note for a send that would repeat one already made for `fire` (it
   * is skipped, not failed), or null when it is new.
   */
  repeat(
    fire: string,
    platform: string,
    to: string,
    sessionId: string,
    message: string
  ): string | null {
    const entry = this.sent.get(this.key(fire, platform, to));
    if (entry == null) return null;
    if (entry.sessionId !== sessionId)
      return `Skipped: ${to} already got a message from this routine for this same scheduled moment, so it was not sent twice. Say in your reply that it was already sent.`;
    if (entry.messages.includes(digest(message)))
      return `Skipped: this exact message already went to ${to} in this run, so it was not sent twice.`;
    return null;
  }

  record(
    fire: string,
    platform: string,
    to: string,
    sessionId: string,
    message: string
  ): void {
    const at = this.now();
    for (const [key, entry] of this.sent)
      if (at - entry.at > KEPT_MS) this.sent.delete(key);
    const key = this.key(fire, platform, to);
    const entry = this.sent.get(key) ?? {
      platform,
      to,
      sessionId,
      messages: [],
      at,
    };
    const sent = digest(message);
    if (!entry.messages.includes(sent)) entry.messages.push(sent);
    this.sent.set(key, entry);
    this.save();
  }

  /** Who `fire`'s runs have already sent to, in the order first sent. */
  recipients(fire: string): Array<{ platform: string; to: string }> {
    const prefix = `${fire}\u0000`;
    return [...this.sent]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => ({ platform: entry.platform, to: entry.to }));
  }

  private save(): void {
    const file = this.options.file?.();
    if (file == null) return;
    try {
      writeFileAtomicSync(file, JSON.stringify([...this.sent]));
    } catch (error) {
      console.error("[routines] could not keep what a run sent:", error);
    }
  }
}

/** Fields a connector call names its target by, said back in that order. */
const TARGET_FIELDS = [
  "to",
  "recipient",
  "channel",
  "subject",
  "summary",
  "title",
];

const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const target = TARGET_FIELDS.flatMap((field) => {
    const value = input[field];
    const text = Array.isArray(value) ? value.join(", ") : value;
    return typeof text === "string" && text.trim().length > 0
      ? [`${field}: ${text.trim().slice(0, 80)}`]
      : [];
  });
  return (
    `${tool} ${String(input.action ?? "")}`.trim() +
    (target.length > 0 ? ` (${target.join("; ")})` : "")
  );
};

/** Tools that reach past the run's answer without a connector, by bare name. */
const OUTWARD_TOOLS: readonly string[] = ["bash", "browser_task", "cronjob"];

/**
 * A finished tool call as a run's report names it, or null when it reached
 * nothing outside the run: a connector call that is not a reviewed read, or a
 * tool that acts by other means, whose input is too long to show.
 */
export const outwardActionOf = (
  name: string,
  input: Record<string, unknown>
): string | null => {
  const meta = connectorToolMetaByName(name);
  if (meta != null)
    return (UNATTENDED_CONNECTOR_READS[meta.tool] ?? []).includes(
      String(input.action ?? "")
    )
      ? null
      : describeCall(meta.tool, input);
  return (
    OUTWARD_TOOLS.find(
      (entry) => name === entry || name.endsWith(`_${entry}`)
    ) ?? null
  );
};

/** Each action once, in the order first made, counted when repeated. */
export const countedActions = (actions: readonly string[]): string[] => {
  const counts = new Map<string, number>();
  for (const action of actions)
    counts.set(action, (counts.get(action) ?? 0) + 1);
  return [...counts].map(([action, count]) =>
    count > 1 ? `${action} ×${count}` : action
  );
};

/**
 * The connector calls a run's thread records that are not reviewed reads
 * (UNATTENDED_CONNECTOR_READS): `done` came back without an error, `unsure`
 * was started and never answered, so it may have gone through.
 */
export const connectorActionsOf = (
  messages: ReadonlyArray<{ parts: readonly unknown[] }>
): { done: string[]; unsure: string[] } => {
  const parts = messages.flatMap((message) => message.parts) as Array<
    Record<string, unknown>
  >;
  const results = new Map(
    parts
      .filter((part) => part.type === "tool-result")
      .map((part) => [String(part.toolCallId), part])
  );
  const done: string[] = [];
  const unsure: string[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call" || typeof part.name !== "string") continue;
    const meta = connectorToolMetaByName(part.name);
    if (meta == null) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(part.arguments ?? "{}"));
      if (parsed != null && typeof parsed === "object")
        input = parsed as Record<string, unknown>;
    } catch {
      // Arguments cut off mid-stream: the action is still named below.
    }
    const action = String(input.action ?? "");
    if ((UNATTENDED_CONNECTOR_READS[meta.tool] ?? []).includes(action))
      continue;
    const result = results.get(String(part.id));
    if (result == null) unsure.push(describeCall(meta.tool, input));
    else if (
      result.state === "complete" &&
      result.outcome == null &&
      result.error == null
    )
      done.push(describeCall(meta.tool, input));
  }
  return { done, unsure };
};
