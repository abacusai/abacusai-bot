import { mkdirSync } from "node:fs";

import {
  dueAgendaItems,
  NUDGE_SUMMARY_MAX_CHARS,
  type NudgeAgendaItem,
  phoneLanguage,
  phoneZone,
  retireNudgedLoops,
  scriptLanguage,
  writePhoneReplyLanguage,
  writePhoneZone,
} from "@abacus-ai/agent/phone-nudges";

import type { PendingWait } from "#main/services/agent-tools/pending-waits";

import type { PhoneInboxEntry } from "./phone-inbox";

/**
 * The phone loop's check-in agenda: what the user's unfinished work is
 * waiting on, as value-free summaries the server may check in about inside
 * the WhatsApp window (`nudge_agenda` on `/v1/abacusaibot_channels`). What
 * waits on the user (a vault page, a payment or sign-in approval, a paused checkout),
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
  /** The phone loop's directory: its loops, zone and languages. */
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

/** A wait is not checked in about sooner than this after it began. */
const WAITING_FLOOR_MS = 2 * 60_000;

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

/** A payee as the server bound it, or its name alone when it reads as a domain ("Amazon.in"). */
function payeeName(merchant: string): string | null {
  const trimmed = merchant.replace(/\s+/g, " ").trim().slice(0, 60);
  if (trimmed.length === 0) return null;
  return DOMAIN_LIKE_RE.test(trimmed) ? siteName(trimmed) : trimmed;
}

/** Anything the server's link check would read as a domain: a word, a dot, two letters. */
const DOMAIN_LIKE_RE = /[a-z0-9-]\.[a-z]{2,}/i;

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
  const payee =
    (wait.merchant != null ? payeeName(wait.merchant) : null) ?? name;
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
    case "signin":
      return `A sign-in${name != null ? ` to ${name}` : ""} is waiting for the user's tap on the page sent.`;
    case "checkout":
      return `A booking or purchase${payee != null ? ` with ${payee}` : ""}${total != null ? ` (${total})` : ""} is paused, waiting for ${PAUSE_NEEDS[wait.stage] ?? "the user"}.`;
  }
}

/**
 * One wait as an agenda item. A connector link is `connect`, `at` when it
 * went (the server waits 2h). Everything else is `waiting`, `at` two minutes
 * after it began at the earliest (a pending approval lives 30 minutes; the
 * server also waits for the bot to be quiet).
 */
export function waitItem(wait: PendingWait): NudgeAgendaItem {
  const connect = wait.kind === "connector";
  return {
    item_id: wait.itemId,
    kind: connect ? "connect" : "waiting",
    at: seconds(wait.since + (connect ? 0 : WAITING_FLOOR_MS)),
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
  /** `checkins language` calls this start that left no language set. */
  private languageRefusals = 0;
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
    this.languageRefusals = 0;
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
   * An inbox poll answered: the server's zone becomes the loop's clock and its
   * language the one the loop replies in (null forgets either; an older
   * server says nothing and nothing changes), and the start's first posts the
   * agenda.
   */
  polled(result: { tz?: unknown; lang?: unknown }): void {
    if (!this.running) return;
    this.save("timezone", serverValue(result.tz), writePhoneZone);
    this.save("language", serverValue(result.lang), writePhoneReplyLanguage);
    if (this.posted) return;
    this.posted = true;
    void this.post(true).then(() => this.readEnabled());
  }

  /** One value the poll carried, saved when the server said anything about it. */
  private save(
    what: string,
    value: string | null | undefined,
    write: (dir: string, value: string | null) => boolean
  ): void {
    if (value === undefined) return;
    try {
      mkdirSync(this.deps.phoneDir, { recursive: true });
      if (write(this.deps.phoneDir, value))
        this.log(`[phone] ${what} ${value ?? "unknown"}`);
    } catch (error) {
      this.log(`[phone] ${what} not saved: ${describe(error)}`);
    }
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
    if (entry.kind === "note" || entry.kind === "event") return [];
    const dir = this.deps.phoneDir;
    if (entry.kind === "linked") {
      const greeting = this.enabled === true ? [CHECKINS_ON_GREETING] : [];
      return entry.first_brief === true ? [FIRST_BRIEF, ...greeting] : greeting;
    }
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
      if (this.languageRefusals < MAX_LANGUAGE_REFUSALS)
        notes.push(SET_LANGUAGE_NOTE);
      const fromScript = scriptLanguage(entry.text ?? "");
      if (fromScript != null) this.scriptLang = fromScript;
    }
    return notes;
  }

  /** The loop called `checkins language`: a call that left none set counts toward giving up the ask. */
  languageCallEnded(): void {
    if (phoneLanguage(this.deps.phoneDir) == null) this.languageRefusals += 1;
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

/** Refused language calls after which a start stops asking: the server will not take one. */
const MAX_LANGUAGE_REFUSALS = 3;

/** While no language is set, every turn asks for it: the server writes check-ins in no other. */
const SET_LANGUAGE_NOTE =
  "[check-ins language] No check-in language is set. Call `checkins` with op language and the code of the " +
  "language the user writes in, without mentioning it, then answer them as usual.";

const FIRST_BRIEF =
  "[first brief] This is the user's first time here: instead of a question, open with a short brief, all in this one " +
  "reply and in their language. Answer their greeting in a few words and greet them by first name. Call " +
  "`current_time` first and date every search from what it returns. If their calendar is connected, " +
  "their next meetings today or tomorrow (time and title, at most 3). If Gmail is connected, the unread emails from " +
  "the last two days: give a number only when you know the real count, never a search's result limit, otherwise say " +
  '"a few"; then the few (at most 3) that look like they need a reply, each as the sender and a few words, skipping ' +
  "newsletters, receipts and promotions. Then offer to draft replies to those into their Gmail Drafts, saying nothing " +
  "will be sent, and ask them to reply yes. Last, one line offering to send this brief here every morning at 8; on " +
  "their yes, set it up with `cronjob`. A service whose tool call fails with an auth, permission or expired-token " +
  "error is not connected: leave it out of the brief, and call `connect_connector` for it and send the link it gives " +
  "to reconnect it. If neither is connected, greet them and offer to connect Google with `connect_connector` so you " +
  "can brief them. Never send an email, and draft only after their yes.";

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
  const hint = upgradeHintNote(entry.upgrade_hint);
  if (hint != null) notes.push(hint);
  if (entry.stop_keyword === true)
    notes.push(
      "[stop keyword] The user wrote only STOP, and nothing was turned off. Ask in one short line, in their language, " +
        "whether they want no more check-ins or want you to stop the task you are on; change nothing until they say."
    );
  return notes;
}

const HINT_FIELD_MAX_CHARS = 80;

/** One field of the server's upgrade hint, or null when it is missing. */
function hintField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, HINT_FIELD_MAX_CHARS);
  return text.length > 0 ? text : null;
}

/**
 * The hidden line for a free account due one soft upgrade line. The agent
 * picks the moment (a finished task, a thanks) or leaves it out.
 */
function upgradeHintNote(hint: PhoneInboxEntry["upgrade_hint"]): string | null {
  const plan = hintField(hint?.plan);
  const firstMonth = hintField(hint?.first_month);
  const priceText = hintField(hint?.price_text);
  if (plan == null || firstMonth == null || priceText == null) return null;
  const messages =
    typeof hint?.messages === "number" && hint.messages > 0
      ? ` and has sent ${Math.floor(hint.messages)} messages`
      : "";
  return (
    `[upgrade hint] The user is on the free plan${messages}. Only if this reply finishes a task for them or answers ` +
    `their thanks, end it with one short, friendly line in their language: what you have done for them so far, that ` +
    `${plan} adds more credits, more routines and top models for ${priceText} (write ${firstMonth} exactly), and ask ` +
    `whether they want the link. On their yes, send it with \`billing_plan\`. Never mid-task, after a complaint or an ` +
    `error, or when you just asked them something: then leave it out.`
  );
}

/** A poll field: a string is the server's value, null clears it, anything else (an older server) says nothing. */
const serverValue = (value: unknown): string | null | undefined =>
  value === null
    ? null
    : typeof value === "string" && value.length > 0
      ? value
      : undefined;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
