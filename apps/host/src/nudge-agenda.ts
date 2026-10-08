import { mkdirSync } from "node:fs";

import {
  dueAgendaItems,
  NUDGE_SUMMARY_MAX_CHARS,
  type NudgeAgendaItem,
  phoneLanguage,
  phoneZone,
  retireNudgedLoops,
  scriptLanguage,
  writePhoneZone,
} from "@abacus-ai/agent/phone-nudges";

import type { PendingWait } from "#main/services/agent-tools/pending-waits";

import type { PhoneInboxEntry } from "./phone-inbox";

/**
 * The phone loop's check-in agenda: what the user's unfinished work is
 * waiting on, as value-free summaries the server may check in about inside
 * the WhatsApp window (`nudge_agenda` on `/v1/abacusaibot_channels`). What
 * waits on the user (a vault page, a payment approval, a paused checkout),
 * loops due soon, connector links not finished, and the language check-ins
 * go out in. Posted on every start (an empty agenda clears what a previous host
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

/** What a paused checkout waits for, by what it paused for. */
const PAUSE_NEEDS: Record<string, string> = {
  details: "the traveler or contact details",
  login: "a sign-in",
  code: "a one-time code",
  payment: "the payment approval",
  captcha: "a CAPTCHA",
  choose: "a choice",
};

/** Second-level labels that are not the site's own name ("co" in "x.co.uk"). */
const GENERIC_LABELS = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);

/**
 * A site by its name alone ("akasaair" for "akasaair.com"): the server
 * refuses any domain in a summary as a link.
 */
export function siteName(site: string): string | null {
  const labels = site.toLowerCase().split(".").filter(Boolean);
  labels.pop();
  while (labels.length > 1 && GENERIC_LABELS.has(labels.at(-1)!)) labels.pop();
  const name = labels.at(-1);
  return name != null && /^[a-z][a-z0-9-]*$/.test(name) ? name : null;
}

/** A total as people write it ("₹5,412"), or null for one that is not a plain number. */
function money(amount: string, currency: string): string | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null;
  const value = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    // Not a currency Intl knows.
    return null;
  }
}

/** One wait as one sentence: its kind and stage, the payee or site's name and a total; never a domain or anything typed. */
function waitSummary(wait: PendingWait): string {
  const name = wait.site != null ? siteName(wait.site) : null;
  const total =
    wait.amount != null && wait.currency != null
      ? money(wait.amount, wait.currency)
      : null;
  const payee = wait.merchant ?? name;
  switch (wait.kind) {
    case "connector":
      return `${(wait.label ?? "A connector").slice(0, 60)} link was sent and is not connected yet.`;
    case "vault_login":
      return `A secure page to sign in${name != null ? ` to ${name}` : ""} was sent and is not finished yet.`;
    case "vault_card":
      return "A secure page to add a card was sent and is not finished yet.";
    case "vault_code":
      return "A secure page for a one-time code was sent and is not finished yet.";
    case "payment":
      return `A payment${total != null ? ` of ${total}` : ""}${payee != null ? ` to ${payee}` : ""} is waiting for the user's approval on the page sent.`;
    case "checkout":
      return `A booking or purchase${payee != null ? ` with ${payee}` : ""}${total != null ? ` (${total})` : ""} is paused, waiting for ${PAUSE_NEEDS[wait.stage] ?? "the user"}.`;
  }
}

/**
 * One wait as an agenda item, `at` when it began: a connector link is
 * `connect` (the server waits 2h); everything else is `waiting`, which the
 * server holds until the bot has been quiet for a while. An approval's page
 * lives about ten minutes, so a later `at` could outlive it.
 */
export function waitItem(wait: PendingWait): NudgeAgendaItem {
  const connect = wait.kind === "connector";
  return {
    item_id: wait.itemId,
    kind: connect ? "connect" : "waiting",
    at: seconds(wait.since),
    expires_at: seconds(wait.expiresAt),
    summary: waitSummary(wait).slice(0, NUDGE_SUMMARY_MAX_CHARS),
  };
}

const seconds = (ms: number): number => Math.floor(ms / 1000);

interface AgendaReply {
  dropped?: Array<{ reason?: unknown }>;
}

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
  /** The server took an agenda this start: it knows check-ins. */
  private supported = false;
  /** The server does not know the action: nothing more is posted this start. */
  private unsupported = false;
  /** Whether the server reports check-ins on; null until it said. */
  private enabled: boolean | null = null;
  /** The user's language as their script names it, while none was set. */
  private scriptLang: string | null = null;
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
    this.supported = false;
    this.unsupported = false;
    this.enabled = null;
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

  /**
   * An inbox poll answered: the server's zone becomes the loop's clock (null
   * forgets it; an older server says nothing and nothing changes), and the
   * start's first posts the agenda.
   */
  polled(result: { tz?: unknown }): void {
    if (!this.running) return;
    const tz =
      result.tz === null
        ? null
        : typeof result.tz === "string" && result.tz.length > 0
          ? result.tz
          : undefined;
    if (tz !== undefined) {
      try {
        mkdirSync(this.deps.phoneDir, { recursive: true });
        if (writePhoneZone(this.deps.phoneDir, tz))
          this.log(`[phone] timezone ${tz ?? "unknown"}`);
      } catch (error) {
        this.log(`[phone] timezone not saved: ${describe(error)}`);
      }
    }
    if (this.posted) return;
    this.posted = true;
    void this.post(true).then(() => this.readEnabled());
  }

  /** A phone turn ended: the agenda goes again, changed or not. */
  turnEnded(): void {
    this.schedule(true);
  }

  /**
   * Hidden lines for the loop ahead of one inbox entry: what the server sent
   * and a bare STOP (nudgeNotes); the ask to set the check-in language while
   * none is set; for the linked greeting, that check-ins are on. Also retires
   * due loops a check-in already covered.
   */
  notes(entry: PhoneInboxEntry): string[] {
    if (entry.kind === "note") return [];
    const dir = this.deps.phoneDir;
    if (entry.kind === "linked")
      return this.enabled === true ? [CHECKINS_ON_GREETING] : [];
    const notes = nudgeNotes(entry);
    const sentAts = (
      Array.isArray(entry.nudges_sent) ? entry.nudges_sent : []
    ).flatMap((nudge) => (typeof nudge?.at === "number" ? [nudge.at] : []));
    try {
      if (retireNudgedLoops(dir, sentAts, phoneZone(dir))) this.schedule(true);
    } catch (error) {
      this.log(`[phone] nudged loops not saved: ${describe(error)}`);
    }
    if (this.supported && phoneLanguage(dir) == null) {
      notes.push(SET_LANGUAGE_NOTE);
      const fromScript = scriptLanguage(entry.text ?? "");
      if (fromScript != null) this.scriptLang = fromScript;
    }
    return notes;
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

  /** What the server is told: waits, due loops and the language, at most MAX_ITEMS. */
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
    const lang = phoneLanguage(dir) ?? this.scriptLang;
    return { ...(lang != null ? { lang } : {}), items };
  }

  private post(force: boolean): Promise<void> {
    const run = this.posting.then(async () => {
      if (!this.running) return;
      const agenda = await this.build();
      const body = JSON.stringify(agenda);
      if (!force && body === this.lastBody) return;
      try {
        const reply = await this.deps.call<AgendaReply>(
          { action: "nudge_agenda", ...agenda },
          CALL_TIMEOUT_MS
        );
        this.lastBody = body;
        this.supported = true;
        const reasons = (Array.isArray(reply?.dropped) ? reply.dropped : [])
          .map((dropped) => dropped?.reason)
          .filter((reason): reason is string => typeof reason === "string");
        if (reasons.length > 0)
          this.log(`[phone] agenda dropped ${reasons.join(",")}`);
      } catch (error) {
        // Said once a start; an older server's refusal also ends the posting.
        if (UNKNOWN_ACTION_RE.test(describe(error))) this.unsupported = true;
        if (!this.refusedOnce)
          this.log(`[phone] agenda not taken: ${describe(error)}`);
        this.refusedOnce = true;
      }
    });
    this.posting = run.catch(() => {});
    return run;
  }

  /** Whether the server has check-ins on, for the linked greeting. */
  private async readEnabled(): Promise<void> {
    if (!this.supported) return;
    try {
      const reply = await this.deps.call<{ ok?: unknown; enabled?: unknown }>(
        { action: "checkins", op: "status" },
        CALL_TIMEOUT_MS
      );
      this.enabled = reply?.ok === true && reply.enabled === true;
    } catch (error) {
      this.log(`[phone] check-in status not read: ${describe(error)}`);
    }
  }
}

/** While no language is set, every turn asks for it: the server writes check-ins in no other. */
const SET_LANGUAGE_NOTE =
  "[check-ins language] No check-in language is set. Call `checkins` with op language and the code of the " +
  "language the user writes in, without mentioning it, then answer them as usual.";

const CHECKINS_ON_GREETING =
  "[check-ins] Check-ins are on: say once in this greeting, in the user's language, that you may check in here " +
  "about their unfinished tasks, and that they can say stop any time.";

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
