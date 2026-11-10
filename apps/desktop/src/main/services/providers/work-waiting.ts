/**
 * "Your work is waiting": after a chat hands over a result and the user goes
 * quiet, one native notice brings them back to it. It names the next step the
 * result ended on (next-step.ts) when there is one, and a click opens the chat,
 * where that step's buttons still sit under the result.
 *
 * At most three notices per result: a few hours after it while the app is
 * still open, the next time the app runs (a computer that starts the app at
 * login gets it the next morning), and once more on day three. Any message
 * from the user, or a click, ends it. The global notifications switch and
 * quiet hours apply, and nothing shows while a turn runs. A focused window is
 * no sign of the user: one the OS opened at login has focus with nobody there.
 */
import fs from "fs";
import path from "path";

/** What a delivered result was (the success pitch's `delivered`). */
type WorkWaitingKind = "site" | "file";

interface WorkWaitingRecord {
  sessionId: string;
  kind: WorkWaitingKind;
  /** The first task of the next step the result ended on, in the user's words. */
  task: string | null;
  resultAt: number;
  shownAt: number[];
  done: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
/** How long after the result each notice may show, in order. */
const WORK_WAITING_AFTER_MS = [3.5 * HOUR_MS, 20 * HOUR_MS, 72 * HOUR_MS];
/** The least time between two notices for one result. */
const WORK_WAITING_GAP_MS = 16 * HOUR_MS;
/** A result older than this is not brought up again. */
const WORK_WAITING_EXPIRES_MS = 7 * 24 * HOUR_MS;
/** The first check after launch: a computer that starts the app at login is brought up then. */
export const WORK_WAITING_FIRST_CHECK_MS = 2 * 60 * 1000;
export const WORK_WAITING_CHECK_EVERY_MS = 15 * 60 * 1000;
/** A task longer than this is cut, so the notice stays one line. */
const TASK_MAX_CHARS = 120;

interface WorkWaitingNotice {
  title: string;
  body: string;
  sessionId: string;
  dedupeKey: string;
}

interface WorkWaitingDeps {
  /** The state file, or null where there is none (the hosted computer). */
  file: () => string | null;
  /** Whether now is inside the user's quiet hours. */
  quiet: (now: number) => boolean;
  /** Whether a turn runs in any session. */
  busy: () => boolean;
  /** Whether the chat still exists. */
  sessionExists: (sessionId: string) => boolean;
  /** A translator for the language the bot answers in (the app's locale files). */
  words: () => Promise<(key: string) => string>;
  show: (notice: WorkWaitingNotice, clicked: () => void) => void;
  funnel: (
    step: "work_waiting_shown" | "work_waiting_clicked",
    detail: string
  ) => void;
  now?: () => number;
}

/** Whether the next notice for `record` is due at `now` (ignoring quiet hours and a running turn). */
function workWaitingDue(
  record: WorkWaitingRecord | null,
  now: number
): boolean {
  if (record == null || record.done) return false;
  if (now - record.resultAt >= WORK_WAITING_EXPIRES_MS) return false;
  const shown = record.shownAt.length;
  const after = WORK_WAITING_AFTER_MS[shown];
  if (after == null || now - record.resultAt < after) return false;
  const last = record.shownAt.at(-1);
  return last == null || now - last >= WORK_WAITING_GAP_MS;
}

/** The task as one short line, or null when there is nothing to say. */
export function workWaitingTask(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > TASK_MAX_CHARS
    ? `${line.slice(0, TASK_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

const isRecord = (value: unknown): value is WorkWaitingRecord => {
  const record = value as Partial<WorkWaitingRecord> | null;
  return (
    record != null &&
    typeof record.sessionId === "string" &&
    (record.kind === "site" || record.kind === "file") &&
    (record.task === null || typeof record.task === "string") &&
    typeof record.resultAt === "number" &&
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

  /** A chat handed over a result: it is the one waiting now. */
  resultDelivered(
    sessionId: string,
    kind: WorkWaitingKind,
    task: string | null
  ): void {
    if (this.deps.file() == null) return;
    this.save({
      sessionId,
      kind,
      task,
      resultAt: this.now(),
      shownAt: [],
      done: false,
    });
  }

  /** The user wrote, anywhere: they are back, so nothing more is said about it. */
  userWrote(): void {
    const record = this.current();
    if (record == null || record.done) return;
    this.save({ ...record, done: true });
  }

  /** Shows the notice if one is due; called on a timer and at launch. */
  async tick(): Promise<boolean> {
    const record = this.current();
    const now = this.now();
    if (!workWaitingDue(record, now) || record == null) return false;
    if (!this.deps.sessionExists(record.sessionId)) {
      this.save({ ...record, done: true });
      return false;
    }
    if (this.deps.quiet(now) || this.deps.busy()) return false;
    const shown = record.shownAt.length + 1;
    // Counted before the words load, so an overlapping check cannot show it twice.
    this.save({ ...record, shownAt: [...record.shownAt, now] });
    const t = await this.deps.words();
    this.deps.show(
      {
        title: t("workWaiting.title"),
        body: record.task ?? t(`workWaiting.${record.kind}`),
        sessionId: record.sessionId,
        dedupeKey: `work-waiting:${record.sessionId}:${record.resultAt}:${shown}`,
      },
      () => this.clicked(record.resultAt)
    );
    this.deps.funnel(
      "work_waiting_shown",
      `${shown}_${record.kind}_${record.task == null ? "plain" : "task"}`
    );
    return true;
  }

  private clicked(resultAt: number): void {
    const record = this.current();
    this.deps.funnel(
      "work_waiting_clicked",
      String(record?.shownAt.length ?? 0)
    );
    if (record != null && record.resultAt === resultAt && !record.done)
      this.save({ ...record, done: true });
  }
}
