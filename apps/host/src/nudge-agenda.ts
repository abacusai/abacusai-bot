import { mkdirSync } from "node:fs";

import {
  dueAgendaItems,
  NUDGE_SUMMARY_MAX_CHARS,
  type NudgeAgendaItem,
  phoneLanguage,
  phoneZone,
  writePhoneZone,
} from "@abacus-ai/agent/phone-nudges";

import type { PendingWait } from "#main/services/agent-tools/pending-waits";

import type { PhoneInboxEntry } from "./phone-inbox";

/**
 * The phone loop's check-in agenda: what the user's unfinished work is
 * waiting on, as value-free summaries the server may check in about inside
 * the WhatsApp window (`nudge_agenda` on `/v1/abacusaibot_channels`). Loops
 * due soon, connector links not finished, and the language check-ins go out
 * in. Posted on every start (an empty agenda clears what a previous host
 * left), after every turn, and when it changes. The server sends the
 * check-ins; nothing here does, and nothing wakes this host for one. A
 * server that does not know the action is left alone.
 */

type ChannelsCall = <T>(
  body: Record<string, unknown>,
  timeoutMs: number
) => Promise<T>;

interface NudgeAgendaDeps {
  call: ChannelsCall;
  /** The phone loop's directory: its loops, zone and check-in language. */
  phoneDir: string;
  /** The phone session's waits; none before it exists. */
  waits: () => Promise<PendingWait[]>;
  now?: () => number;
  log?: (line: string) => void;
}

const NUDGE_AGENDA_TIMINGS = {
  /** Changes this close together go as one post. */
  debounceMs: 5_000,
  /** How often the agenda is rebuilt to see whether it changed. */
  checkEveryMs: 15_000,
};

const CALL_TIMEOUT_MS = 20_000;
/** How a server without the action refuses it. */
const UNKNOWN_ACTION_RE = /action must be one of/i;
/** The server keeps at most this many items. */
const MAX_ITEMS = 10;
/** A connector link not finished is worth one check-in this long after it went. */
const CONNECT_AFTER_MS = 2 * 60 * 60_000;

/** One wait as an agenda item: its kind and stage, never anything typed. */
export function waitItem(wait: PendingWait): NudgeAgendaItem {
  const name = (wait.label ?? "A connector").slice(0, 60);
  return {
    item_id: wait.itemId,
    kind: "connect",
    at: seconds(wait.since + CONNECT_AFTER_MS),
    expires_at: seconds(wait.expiresAt),
    summary: `${name} link was sent and is not connected yet.`.slice(
      0,
      NUDGE_SUMMARY_MAX_CHARS
    ),
  };
}

const seconds = (ms: number): number => Math.floor(ms / 1000);

export class NudgeAgenda {
  private readonly timings: typeof NUDGE_AGENDA_TIMINGS;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private running = false;
  /** The first poll of a start posts, empty or not. */
  private posted = false;
  private debounce: NodeJS.Timeout | null = null;
  private check: NodeJS.Timeout | null = null;
  /** The last body the server took. */
  private lastBody: string | null = null;
  private refusedOnce = false;
  /** The server does not know the action: nothing more is posted this start. */
  private unsupported = false;
  /** A pending post goes even when nothing changed. */
  private forceNext = false;
  private posting: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: NudgeAgendaDeps,
    timings: Partial<typeof NUDGE_AGENDA_TIMINGS> = {}
  ) {
    this.timings = { ...NUDGE_AGENDA_TIMINGS, ...timings };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.posted = false;
    this.lastBody = null;
    this.refusedOnce = false;
    this.unsupported = false;
    this.check = setInterval(
      () => this.schedule(false),
      this.timings.checkEveryMs
    );
    this.check.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.debounce != null) clearTimeout(this.debounce);
    if (this.check != null) clearInterval(this.check);
    this.debounce = null;
    this.check = null;
  }

  /** An inbox poll answered: the user's zone becomes the loop's clock; the start's first posts the agenda. */
  polled(result: { tz?: unknown }): void {
    if (!this.running) return;
    if (typeof result.tz === "string" && result.tz.length > 0) {
      try {
        mkdirSync(this.deps.phoneDir, { recursive: true });
        if (writePhoneZone(this.deps.phoneDir, result.tz))
          this.log(`[phone] timezone ${result.tz}`);
      } catch (error) {
        this.log(`[phone] timezone not saved: ${describe(error)}`);
      }
    }
    if (this.posted) return;
    this.posted = true;
    void this.post(true);
  }

  /** A phone turn ended: the agenda goes again, changed or not. */
  turnEnded(): void {
    this.schedule(true);
  }

  private schedule(force: boolean): void {
    if (!this.running || !this.posted || this.unsupported) return;
    this.forceNext ||= force;
    if (this.debounce != null) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const forced = this.forceNext;
      this.forceNext = false;
      void this.post(forced);
    }, this.timings.debounceMs);
    this.debounce.unref?.();
  }

  /** What the server is told: due loops, waits, and the language, at most MAX_ITEMS. */
  async build(): Promise<{ lang?: string; items: NudgeAgendaItem[] }> {
    const dir = this.deps.phoneDir;
    const now = this.now();
    const waits = (await this.deps.waits().catch(() => []))
      .filter((wait) => wait.expiresAt > now)
      .map(waitItem);
    const due = dueAgendaItems(dir, now, phoneZone(dir));
    // Waiting first, then due, then connect: the server's own order.
    const rank = { waiting: 0, due: 1, connect: 2 } as const;
    const items = [...waits, ...due]
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at)
      .slice(0, MAX_ITEMS);
    const lang = phoneLanguage(dir);
    return { ...(lang != null ? { lang } : {}), items };
  }

  private post(force: boolean): Promise<void> {
    const run = this.posting.then(async () => {
      if (!this.running) return;
      const agenda = await this.build();
      const body = JSON.stringify(agenda);
      if (!force && body === this.lastBody) return;
      try {
        await this.deps.call(
          { action: "nudge_agenda", ...agenda },
          CALL_TIMEOUT_MS
        );
        this.lastBody = body;
      } catch (error) {
        // Said once a start; an older server's refusal also ends the posting.
        this.lastBody = body;
        if (UNKNOWN_ACTION_RE.test(describe(error))) this.unsupported = true;
        if (!this.refusedOnce)
          this.log(`[phone] agenda not taken: ${describe(error)}`);
        this.refusedOnce = true;
      }
    });
    this.posting = run.catch(() => {});
    return run;
  }
}

/** Longest check-in text the loop is shown. */
const NUDGE_TEXT_MAX_CHARS = 600;
const NUDGES_SHOWN = 5;

/**
 * Hidden lines the loop reads before a user message: the check-ins the
 * server sent since the user last wrote, and a bare STOP that turned
 * nothing off. Tagged, so they are never taken for the user's words.
 */
export function nudgeNotes(entry: PhoneInboxEntry): string[] {
  const notes: string[] = [];
  const sent = (Array.isArray(entry.nudges_sent) ? entry.nudges_sent : [])
    .map((nudge) =>
      typeof nudge?.text === "string"
        ? nudge.text.replace(/\s+/g, " ").trim()
        : ""
    )
    .filter((text) => text.length > 0)
    .slice(-NUDGES_SHOWN)
    .map((text) => JSON.stringify(text.slice(0, NUDGE_TEXT_MAX_CHARS)));
  if (sent.length > 0)
    notes.push(
      `[check-ins sent] Since the user's last message the app texted them: ${sent.join("; ")}. Their message may answer that.`
    );
  if (entry.stop_keyword === true)
    notes.push(
      "[stop keyword] The user wrote only STOP, and nothing was turned off. Ask in one short line, in their language, " +
        "whether they want no more check-ins or want you to stop the task you are on; change nothing until they say."
    );
  return notes;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
