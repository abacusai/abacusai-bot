/**
 * "Your work is waiting": whenever the user stops using the app, one native
 * notice brings them back to where they left off. Each time they go quiet it
 * starts again: what they left is the last place their own words went (a chat,
 * a bot's chat, a channel). The title names it (its title stays on this
 * computer) and changes with each notice; how that turn ended picks the body:
 *
 * - a result it handed over: the next step it ended on (next-step.ts), with a
 *   button that opens the chat with that step in the composer, else that the
 *   site or file is ready;
 * - a question for them: that the chat waits for their answer;
 * - a turn that stopped partway: that it can go on from there;
 * - any other reply: pick up where they left off, in that chat.
 *
 * A routine that finished while they were away takes the place of a plain
 * reply: it has new results to look at.
 *
 * At most four notices per absence: a few hours after it while the app is
 * still open, the next time the app runs (a computer that starts the app at
 * login gets it the next morning), on day three and on day seven, where a free
 * account also hears the free credits it has left and until when. Credits that
 * come back on the account while the user is away (creditsBack: at least as
 * long as the first notice waits, on an absence not ended or expired) add one
 * notice of their own at the next check: the work they left stopped at the
 * credit wall and can now go on. The user's next message anywhere starts a
 * new absence; a click ends this one. The global notifications switch, the
 * project reminders switch and quiet hours apply, and nothing shows while a
 * turn runs. A focused window is no sign of the user: one the OS opened at
 * login has focus with nobody there.
 */
import fs from "fs";
import path from "path";

import type { NotificationMetadata } from "@abacus-ai/contract/contract";

/** Where the user left off: a chat (a bot's too), a channel, or a routine's run. */
export type WorkWaitingPlace =
  | { kind: "session"; sessionId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "routine"; routineId: string; sessionId: string };

/** How what they left ended; it picks the notice's words. */
export type WorkWaitingEnding =
  | "site"
  | "file"
  | "question"
  | "unfinished"
  | "chat"
  | "routine";

interface WorkWaitingRecord {
  place: WorkWaitingPlace;
  ending: WorkWaitingEnding;
  /** The first task of the next step a result ended on, in full: the button's draft. The body shortens it. */
  task: string | null;
  /** The question the result's reply ended on, offering that task; absent on older records. */
  offer?: string | null;
  /** When the user was last there: their own turn's end, or the channel's last word. */
  leftAt: number;
  shownAt: number[];
  done: boolean;
  /** Credits came back while the user was away: how many, and whether that notice showed. */
  creditsBack?: { credits: number; shown: boolean };
}

const HOUR_MS = 60 * 60 * 1000;
/** How long after the user left each notice may show, in order. */
const WORK_WAITING_AFTER_MS = [
  3.5 * HOUR_MS,
  20 * HOUR_MS,
  72 * HOUR_MS,
  168 * HOUR_MS,
];
/** The least time between two notices for one absence. */
const WORK_WAITING_GAP_MS = 16 * HOUR_MS;
/** Credits that come back this soon after the user's last word reach someone still here: no notice. */
const CREDITS_BACK_AWAY_MS = WORK_WAITING_AFTER_MS[0];
/** An absence older than this is not brought up again; past day seven, so the last notice has a day to show. */
const WORK_WAITING_EXPIRES_MS = 8 * 24 * HOUR_MS;
/** The first check after launch: a computer that starts the app at login is brought up then. */
export const WORK_WAITING_FIRST_CHECK_MS = 2 * 60 * 1000;
export const WORK_WAITING_CHECK_EVERY_MS = 15 * 60 * 1000;
/** A task or a name longer than this is cut, so the notice stays one line. */
const LINE_MAX_CHARS = 120;
/** A name in a title longer than this is cut: the OS cuts a long title on its own, mid-word. */
const TITLE_NAME_MAX_CHARS = 40;

type Translate = (
  key: string,
  values?: Record<string, string | number>
) => string;

export interface WorkWaitingNotice {
  title: string;
  body: string;
  place: WorkWaitingPlace;
  dedupeKey: string;
  /** A button that opens the place with `draft` in its composer, never sent. */
  action?: { label: string; draft: string };
}

interface WorkWaitingDeps {
  /** The state file, or null where there is none (the hosted computer). */
  file: () => string | null;
  /** Whether now is inside the user's quiet hours. */
  quiet: (now: number) => boolean;
  /** The notifications switch and the project reminders switch are both on. */
  enabled: () => boolean;
  /** Whether a turn runs in any session. */
  busy: () => boolean;
  /** What the place is called (a chat's title, a bot's, a channel's, a routine's); null when it is gone. */
  nameOf: (place: WorkWaitingPlace) => { name: string | null } | null;
  /** A translator for the language the bot answers in (the app's locale files), and its locale. */
  words: () => Promise<{ t: Translate; locale: string }>;
  /** A free account's credits left and when they end (ISO), when the app can tell both; null otherwise. */
  freeCredits: () => Promise<{ credits: number; until: string } | null>;
  /**
   * `clicked(true)` is the action button, `clicked(false)` the notice itself;
   * `displayed` runs once the OS has shown it (never when it is off or failed).
   */
  show: (
    notice: WorkWaitingNotice,
    clicked: (action: boolean) => void,
    displayed: () => void
  ) => void;
  funnel: (
    step: "work_waiting_shown" | "work_waiting_clicked",
    detail: string
  ) => void;
  now?: () => number;
}

/** Where a click on the notice opens: the chat (a bot's opens in its bot), the channel, the routine's run. */
export const workWaitingMetadata = (
  place: WorkWaitingPlace
): NotificationMetadata =>
  place.kind === "channel"
    ? { kind: "channel", channelId: place.channelId }
    : place.kind === "routine"
      ? {
          kind: "routine",
          routineId: place.routineId,
          sessionId: place.sessionId,
        }
      : { sessionId: place.sessionId };

const samePlace = (a: WorkWaitingPlace, b: WorkWaitingPlace): boolean =>
  a.kind === "channel"
    ? b.kind === "channel" && a.channelId === b.channelId
    : b.kind !== "channel" && a.sessionId === b.sessionId;

/** Whether the next notice for `record` is due at `now` (ignoring quiet hours and a running turn). */
function workWaitingDue(
  record: WorkWaitingRecord | null,
  now: number
): boolean {
  if (record == null || record.done) return false;
  if (now - record.leftAt >= WORK_WAITING_EXPIRES_MS) return false;
  const shown = record.shownAt.length;
  const after = WORK_WAITING_AFTER_MS[shown];
  if (after == null || now - record.leftAt < after) return false;
  const last = record.shownAt.at(-1);
  return last == null || now - last >= WORK_WAITING_GAP_MS;
}

/** A task or a name as one short line, or null when there is nothing to say. */
export function workWaitingLine(
  text: unknown,
  max = LINE_MAX_CHARS
): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A reply's closing question (any script's question mark). */
const ASKS = /[?？؟\u037e]$/u;

/**
 * The question a result's reply ends on ("Want me to add a high-score board
 * next?"), as plain text: its last sentence, without Markdown. Null when the
 * reply does not end on one, or it is too long for a notice.
 */
export function workWaitingOffer(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const last = reply
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\*\*|__|`/g, "")
        .replace(/^[\s>#*-]+/, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    .at(-1);
  if (last == null || !ASKS.test(last)) return null;
  const question =
    last
      .split(/(?<=[.!?])\s+|(?<=[。！？])/u)
      .at(-1)
      ?.trim() ?? "";
  return question.length > 0 && question.length <= LINE_MAX_CHARS
    ? question
    : null;
}

/** What each notice of an absence reports to the funnel: its stage, the ending, and whether it named a task. */
const funnelCode = (stage: number, record: WorkWaitingRecord): string =>
  `${stage}_${record.ending}_${record.task == null ? "plain" : "task"}`;

const ENDINGS: readonly WorkWaitingEnding[] = [
  "site",
  "file",
  "question",
  "unfinished",
  "chat",
  "routine",
];

const isPlace = (value: unknown): value is WorkWaitingPlace => {
  const place = value as Record<string, unknown> | null;
  if (place == null) return false;
  if (place.kind === "channel") return typeof place.channelId === "string";
  if (place.kind === "routine")
    return (
      typeof place.routineId === "string" && typeof place.sessionId === "string"
    );
  return place.kind === "session" && typeof place.sessionId === "string";
};

const isRecord = (value: unknown): value is WorkWaitingRecord => {
  const record = value as Partial<WorkWaitingRecord> | null;
  return (
    record != null &&
    isPlace(record.place) &&
    ENDINGS.includes(record.ending as WorkWaitingEnding) &&
    (record.task === null || typeof record.task === "string") &&
    // Absent on a record written before offers were kept.
    (record.offer == null || typeof record.offer === "string") &&
    typeof record.leftAt === "number" &&
    Array.isArray(record.shownAt) &&
    record.shownAt.every((at) => typeof at === "number") &&
    typeof record.done === "boolean" &&
    // Absent on a record written before credits-back notices existed.
    (record.creditsBack === undefined ||
      (typeof record.creditsBack?.credits === "number" &&
        typeof record.creditsBack.shown === "boolean"))
  );
};

export class WorkWaiting {
  private record: WorkWaitingRecord | null | undefined = undefined;

  constructor(private readonly deps: WorkWaitingDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The one record, read once from its file. */
  private current(): WorkWaitingRecord | null {
    if (this.record !== undefined) return this.record;
    const file = this.deps.file();
    let record: WorkWaitingRecord | null = null;
    if (file != null) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
        record = isRecord(parsed) ? parsed : null;
      } catch {
        // No file yet, or one a crash cut short: nothing is waiting.
      }
    }
    this.record = record;
    return record;
  }

  private save(record: WorkWaitingRecord): void {
    this.record = record;
    const file = this.deps.file();
    if (file == null) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(record));
      fs.renameSync(temp, file);
    } catch (error) {
      console.warn(`[work-waiting] not saved: ${String(error)}`);
    }
  }

  /** The user's own words went to `place`: they are here, and a new absence starts from there. */
  userWrote(place: WorkWaitingPlace): void {
    if (this.deps.file() == null) return;
    this.save({
      place,
      ending: "chat",
      task: null,
      leftAt: this.now(),
      shownAt: [],
      done: false,
    });
  }

  /**
   * A turn the user's words opened in `sessionId` ended: if that is where they
   * left off, how it ended is what the notice says, and the absence starts now.
   */
  turnEnded(
    sessionId: string,
    ending: Exclude<WorkWaitingEnding, "routine">,
    task: string | null,
    /** The turn's final reply, whose closing question offers `task`. */
    reply: string | null = null
  ): void {
    const record = this.current();
    if (
      record == null ||
      record.done ||
      record.shownAt.length > 0 ||
      record.place.kind !== "session" ||
      record.place.sessionId !== sessionId
    )
      return;
    const full = typeof task === "string" ? task.trim() || null : null;
    this.save({
      ...record,
      ending,
      task: full,
      offer: full == null ? null : workWaitingOffer(reply),
      leftAt: this.now(),
    });
  }

  /** The channel the user left still talks: the absence starts at its last word. */
  channelSpoke(channelId: string): void {
    const record = this.current();
    if (
      record == null ||
      record.done ||
      record.shownAt.length > 0 ||
      !samePlace(record.place, { kind: "channel", channelId })
    )
      return;
    this.save({ ...record, leftAt: this.now() });
  }

  /**
   * A routine run finished with something to show while the user was away:
   * it is what the notice brings up, unless what they left says more.
   */
  routineRan(routineId: string, sessionId: string): void {
    const record = this.current();
    if (record == null || record.done || record.ending !== "chat") return;
    if (samePlace(record.place, { kind: "session", sessionId })) return;
    this.save({
      ...record,
      place: { kind: "routine", routineId, sessionId },
      ending: "routine",
      task: null,
      offer: null,
    });
  }

  /**
   * Credits came back on the account (the credit wall lifted while the user was
   * away, not by a paid plan): the next check tells them, once, with the place
   * they left. Nothing to point at (no absence on record): nothing to say.
   */
  creditsBack(credits: number): void {
    const record = this.current();
    const now = this.now();
    if (
      record == null ||
      record.done ||
      record.creditsBack?.shown === false ||
      now - record.leftAt >= WORK_WAITING_EXPIRES_MS ||
      // Not away yet: the user sees the credits in the app.
      now - record.leftAt < CREDITS_BACK_AWAY_MS
    )
      return;
    this.save({
      ...record,
      creditsBack: { credits: Math.floor(credits), shown: false },
    });
  }

  /** Shows the notice if one is due; called on a timer and at launch. */
  async tick(): Promise<boolean> {
    const record = this.current();
    const now = this.now();
    const pending = record?.creditsBack;
    if (record != null && pending != null && !pending.shown)
      return this.showCreditsBack(record, pending.credits, now);
    if (!workWaitingDue(record, now) || record == null) return false;
    const found = this.deps.nameOf(record.place);
    if (found == null) {
      this.save({ ...record, done: true });
      return false;
    }
    if (!this.deps.enabled() || this.deps.quiet(now) || this.deps.busy())
      return false;
    const stage = record.shownAt.length + 1;
    // Counted before the words load, so an overlapping check cannot show it twice.
    this.save({ ...record, shownAt: [...record.shownAt, now] });
    const [{ t, locale }, credits] = await Promise.all([
      this.deps.words(),
      stage === WORK_WAITING_AFTER_MS.length
        ? this.deps.freeCredits().catch(() => null)
        : Promise.resolve(null),
    ]);
    const name = workWaitingLine(found.name, TITLE_NAME_MAX_CHARS);
    const creditsLine = freeCreditsLine(credits, now, locale, t);
    const code = `${funnelCode(stage, record)}${creditsLine == null ? "" : "_credits"}`;
    const draft = record.place.kind === "channel" ? null : record.task;
    this.deps.show(
      {
        title:
          name == null
            ? t(`workWaiting.title${stage}Plain`)
            : t(`workWaiting.title${stage}`, { name }),
        body: creditsLine ?? workWaitingBody(record, stage, t),
        place: record.place,
        dedupeKey: `work-waiting:${record.leftAt}:${stage}`,
        ...(draft == null
          ? {}
          : { action: { label: t("workWaiting.nextAction"), draft } }),
      },
      (action) => this.clicked(record.leftAt, action ? `${code}_next` : code),
      () => this.deps.funnel("work_waiting_shown", code)
    );
    return true;
  }

  private async showCreditsBack(
    record: WorkWaitingRecord,
    credits: number,
    now: number
  ): Promise<boolean> {
    const found = this.deps.nameOf(record.place);
    if (found == null) {
      this.save({
        ...record,
        done: true,
        creditsBack: { credits, shown: true },
      });
      return false;
    }
    if (!this.deps.enabled() || this.deps.quiet(now) || this.deps.busy())
      return false;
    const name = workWaitingLine(found.name);
    // Marked before the words load, so an overlapping check cannot show it twice. It counts as one of the absence's
    // notices, so the next one keeps the usual gap.
    this.save({
      ...record,
      shownAt: [...record.shownAt, now],
      creditsBack: { credits, shown: true },
    });
    const { t } = await this.deps.words();
    this.deps.show(
      {
        title: t("workWaiting.creditsTitle"),
        body:
          name == null
            ? t("workWaiting.creditsPlain", { credits })
            : t("workWaiting.credits", { credits, name }),
        place: record.place,
        dedupeKey: `work-waiting:${record.leftAt}:credits`,
      },
      () => this.clicked(record.leftAt, "credits_back"),
      () => this.deps.funnel("work_waiting_shown", "credits_back")
    );
    return true;
  }

  private clicked(leftAt: number, code: string): void {
    this.deps.funnel("work_waiting_clicked", code);
    const record = this.current();
    if (record != null && record.leftAt === leftAt && !record.done)
      this.save({ ...record, done: true });
  }
}

/**
 * The body of the absence's `stage`th notice: the result's own offer, its next
 * step, or a line for how the turn ended, alternating so no two notices of one
 * absence read the same.
 */
export function workWaitingBody(
  record: Pick<WorkWaitingRecord, "ending" | "task" | "offer">,
  stage: number,
  t: Translate
): string {
  const again = stage % 2 === 0;
  const task = workWaitingLine(record.task);
  if (task != null)
    return again
      ? t("workWaiting.nextAgain", { task })
      : (record.offer ?? t("workWaiting.next", { task }));
  return t(`workWaiting.${record.ending}${again ? "Again" : ""}`);
}

/** Day seven's line for a free account with credits left that have not run out yet; null otherwise. */
function freeCreditsLine(
  credits: { credits: number; until: string } | null,
  now: number,
  locale: string,
  t: Translate
): string | null {
  if (credits == null || !(credits.credits >= 1)) return null;
  const until = Date.parse(credits.until);
  if (!Number.isFinite(until) || until <= now) return null;
  let date: string;
  let count: string;
  try {
    date = new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
    }).format(until);
    count = Math.floor(credits.credits).toLocaleString(locale);
  } catch {
    // A locale tag Intl does not know reads in English.
    date = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
    }).format(until);
    count = Math.floor(credits.credits).toLocaleString("en-US");
  }
  return t("workWaiting.freeCredits", { credits: count, date });
}
