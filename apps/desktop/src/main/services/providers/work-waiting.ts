/**
 * "Your work is waiting": whenever the user stops using the app, one native
 * notice brings them back to where they left off. Each time they go quiet it
 * starts again: what they left is the last place their own words went (a chat,
 * a bot's chat, a channel), and how that turn ended picks the words:
 *
 * - a result it handed over: the next step it ended on (next-step.ts), else
 *   that the site or file is ready;
 * - a question for them: that the chat waits for their answer;
 * - a turn that stopped partway: that it can go on from there;
 * - any other reply: pick up where they left off, in that chat.
 *
 * A routine that finished while they were away takes the place of a plain
 * reply: it has new results to look at.
 *
 * At most three notices per absence: a few hours after it while the app is
 * still open, the next time the app runs (a computer that starts the app at
 * login gets it the next morning), and once more on day three. The user's next
 * message anywhere starts a new absence; a click ends this one. The global
 * notifications switch and quiet hours apply, and nothing shows while a turn
 * runs. A focused window is no sign of the user: one the OS opened at login
 * has focus with nobody there.
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
  /** The first task of the next step a result ended on, in the user's words. */
  task: string | null;
  /** When the user was last there: their own turn's end, or the channel's last word. */
  leftAt: number;
  shownAt: number[];
  done: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
/** How long after the user left each notice may show, in order. */
const WORK_WAITING_AFTER_MS = [3.5 * HOUR_MS, 20 * HOUR_MS, 72 * HOUR_MS];
/** The least time between two notices for one absence. */
const WORK_WAITING_GAP_MS = 16 * HOUR_MS;
/** An absence older than this is not brought up again. */
const WORK_WAITING_EXPIRES_MS = 7 * 24 * HOUR_MS;
/** The first check after launch: a computer that starts the app at login is brought up then. */
export const WORK_WAITING_FIRST_CHECK_MS = 2 * 60 * 1000;
export const WORK_WAITING_CHECK_EVERY_MS = 15 * 60 * 1000;
/** A task or a name longer than this is cut, so the notice stays one line. */
const LINE_MAX_CHARS = 120;

interface WorkWaitingNotice {
  title: string;
  body: string;
  place: WorkWaitingPlace;
  dedupeKey: string;
}

interface WorkWaitingDeps {
  /** The state file, or null where there is none (the hosted computer). */
  file: () => string | null;
  /** Whether now is inside the user's quiet hours. */
  quiet: (now: number) => boolean;
  /** Whether a turn runs in any session. */
  busy: () => boolean;
  /** What the place is called (a chat's title, a bot's, a channel's, a routine's); null when it is gone. */
  nameOf: (place: WorkWaitingPlace) => { name: string | null } | null;
  /** A translator for the language the bot answers in (the app's locale files). */
  words: () => Promise<
    (key: string, values?: Record<string, string | number>) => string
  >;
  show: (notice: WorkWaitingNotice, clicked: () => void) => void;
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
export function workWaitingLine(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > LINE_MAX_CHARS
    ? `${line.slice(0, LINE_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

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
    typeof record.leftAt === "number" &&
    Array.isArray(record.shownAt) &&
    record.shownAt.every((at) => typeof at === "number") &&
    typeof record.done === "boolean"
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
    task: string | null
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
    this.save({ ...record, ending, task, leftAt: this.now() });
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
    });
  }

  /** Shows the notice if one is due; called on a timer and at launch. */
  async tick(): Promise<boolean> {
    const record = this.current();
    const now = this.now();
    if (!workWaitingDue(record, now) || record == null) return false;
    const found = this.deps.nameOf(record.place);
    if (found == null) {
      this.save({ ...record, done: true });
      return false;
    }
    const name = workWaitingLine(found.name);
    if (this.deps.quiet(now) || this.deps.busy()) return false;
    const shown = record.shownAt.length + 1;
    // Counted before the words load, so an overlapping check cannot show it twice.
    this.save({ ...record, shownAt: [...record.shownAt, now] });
    const t = await this.deps.words();
    this.deps.show(
      {
        title: t("workWaiting.title"),
        body: this.body(record, name, t),
        place: record.place,
        dedupeKey: `work-waiting:${record.leftAt}:${shown}`,
      },
      () => this.clicked(record.leftAt)
    );
    this.deps.funnel(
      "work_waiting_shown",
      `${shown}_${record.ending}_${record.task == null ? "plain" : "task"}`
    );
    return true;
  }

  private body(
    record: WorkWaitingRecord,
    name: string | null,
    t: (key: string, values?: Record<string, string | number>) => string
  ): string {
    if (record.task != null) return record.task;
    if (record.ending === "site" || record.ending === "file")
      return t(`workWaiting.${record.ending}`);
    // A chat with no title yet still has its words.
    return name == null
      ? t(`workWaiting.${record.ending}Plain`)
      : t(`workWaiting.${record.ending}`, { name });
  }

  private clicked(leftAt: number): void {
    const record = this.current();
    this.deps.funnel(
      "work_waiting_clicked",
      String(record?.shownAt.length ?? 0)
    );
    if (record != null && record.leftAt === leftAt && !record.done)
      this.save({ ...record, done: true });
  }
}
