/**
 * Whether two routines are the same job, for the `cronjob` tool (before it
 * makes one) and the Routines list (which flags pairs a user already has).
 * Only routines of one owner are compared: two bots watching one channel are
 * two jobs. Nothing here is a language model's opinion, and a schedule alone
 * never makes two routines the same.
 */
import { CHECK_IN_PROMPT } from "../bots/check-in";
import { CronParseError, parseCron, type ParsedCron } from "./cron";

/** What a routine is compared on; a request to make one has the same shape. */
export interface RoutineFacts {
  name: string;
  /** A reminder's text, for a hosted reminder. */
  prompt: string;
  schedule: string | null;
  runAt: number | null;
  botId: string | null;
  /** Fires by a webhook too: a request for one is never met by a routine without. */
  webhook: boolean;
  /** Null: read in this computer's local time, or not said. */
  timezone: string | null;
  /** The one page a watch reads. */
  watchUrl: string | null;
}

/**
 * `same`: the same job in the same words, so a second one is never right.
 * `alike`: very probably the same job, said differently. The maker has to
 * read the existing routine and say the new one is separate.
 */
export type RoutineMatch = "same" | "alike";

export interface RoutineMatchContext {
  /**
   * The bot's mission or check-in was just edited: a routine it makes now
   * follows from that edit, so its check-in answers for any routine on that
   * rhythm, and one with its old job at a new time is that job moved.
   */
  missionEdited?: boolean;
}

/** How much of two instructions' wording has to be shared to read as one job. */
const ALIKE_WORDING = 0.6;

/** How far apart two one-time moments still mean one: a retry reads "in 10 minutes" later. */
const ONCE_WINDOW_MS = 2 * 60_000;

const folded = (text: string): string =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const words = (text: string): string[] =>
  folded(text).match(/[\p{L}\p{N}]+/gu) ?? [];

const sameWords = (a: string, b: string): boolean =>
  words(a).join(" ") === words(b).join(" ");

/** The wording two instructions share, 0 to 1. Words under three letters say little. */
const wordingOverlap = (a: string, b: string): number => {
  const left = new Set(words(a).filter((word) => word.length >= 3));
  const right = new Set(words(b).filter((word) => word.length >= 3));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
};

/** `#team-updates`: a place a routine works in. A colour or an issue number is not one. */
const channels = (text: string): Set<string> =>
  new Set(
    (
      folded(text).match(/(?<![\p{L}\p{N}/&])#\p{L}[\p{L}\p{N}_-]+/gu) ?? []
    ).filter((tag) => !/^#[\da-f]{3,8}$/.test(tag))
  );

const sharesChannel = (a: string, b: string): boolean => {
  const right = channels(b);
  return [...channels(a)].some((channel) => right.has(channel));
};

const parsed = (schedule: string | null): ParsedCron | null => {
  if (schedule == null) return null;
  try {
    return parseCron(schedule);
  } catch (error) {
    // A stored expression that no longer parses fires nothing to compare.
    if (error instanceof CronParseError) return null;
    throw error;
  }
};

const sameValues = (a: Set<number>, b: Set<number>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

/** The hours and days, whichever way each cron spells them. */
const sameDaysAndHours = (a: ParsedCron, b: ParsedCron): boolean =>
  sameValues(a.hour.values, b.hour.values) &&
  sameValues(a.dayOfMonth.values, b.dayOfMonth.values) &&
  sameValues(a.month.values, b.month.values) &&
  sameValues(a.dayOfWeek.values, b.dayOfWeek.values) &&
  a.bothDaysRestricted === b.bothDaysRestricted;

const sameZone = (a: RoutineFacts, b: RoutineFacts): boolean =>
  a.timezone == null || b.timezone == null || a.timezone === b.timezone;

/** They fire at the very same moments: `0,30 6-22 * * *` is `*\/30 6-22 * * *`. */
const sameMoments = (a: RoutineFacts, b: RoutineFacts): boolean => {
  if (!sameZone(a, b)) return false;
  if (a.schedule != null || b.schedule != null) {
    const left = parsed(a.schedule);
    const right = parsed(b.schedule);
    return (
      left != null &&
      right != null &&
      sameValues(left.minute.values, right.minute.values) &&
      sameDaysAndHours(left, right)
    );
  }
  if (a.runAt != null || b.runAt != null)
    return (
      a.runAt != null &&
      b.runAt != null &&
      Math.abs(a.runAt - b.runAt) <= ONCE_WINDOW_MS
    );
  // Neither has a time: both fire only on a webhook.
  return true;
};

/** The same rhythm, whichever minute of the hour: a model writes "every hour" as :00. */
const sameRhythm = (a: RoutineFacts, b: RoutineFacts): boolean => {
  const left = parsed(a.schedule);
  const right = parsed(b.schedule);
  return (
    left != null &&
    right != null &&
    sameZone(a, b) &&
    left.minute.values.size === right.minute.values.size &&
    sameDaysAndHours(left, right)
  );
};

const isCheckIn = (routine: RoutineFacts): boolean =>
  routine.botId != null && routine.prompt === CHECK_IN_PROMPT;

/** What a bot calls a check-in of its own: the app's word, or the check-in's own name. */
const callsItselfCheckIn = (
  made: RoutineFacts,
  checkIn: RoutineFacts
): boolean =>
  /check[\s-]?in/iu.test(`${made.name} ${made.prompt}`) ||
  sameWords(made.name, checkIn.name);

const checkInTwin = (
  made: RoutineFacts,
  checkIn: RoutineFacts,
  context: RoutineMatchContext
): boolean =>
  isCheckIn(checkIn) &&
  !isCheckIn(made) &&
  sameRhythm(made, checkIn) &&
  (context.missionEdited === true || callsItselfCheckIn(made, checkIn));

/** How `made` compares with `existing`; null for two different jobs. */
export const routineMatch = (
  made: RoutineFacts,
  existing: RoutineFacts,
  context: RoutineMatchContext = {}
): RoutineMatch | null => {
  if (made.botId !== existing.botId) return null;
  // Asked for a webhook, or a page, that the other does not have: not met by it.
  if (made.webhook && !existing.webhook) return null;
  if (
    made.watchUrl != null &&
    existing.watchUrl != null &&
    made.watchUrl !== existing.watchUrl
  )
    return null;
  if (checkInTwin(made, existing, context)) return "alike";
  const moments = sameMoments(made, existing);
  if (moments && sameWords(made.prompt, existing.prompt)) return "same";
  const wording = wordingOverlap(made.prompt, existing.prompt) >= ALIKE_WORDING;
  // A timeless routine has only its words, and those were not the same.
  if (made.schedule == null && made.runAt == null) return null;
  if (moments && (wording || sameWords(made.name, existing.name)))
    return "alike";
  if (moments && sharesChannel(made.prompt, existing.prompt)) return "alike";
  return context.missionEdited === true && wording ? "alike" : null;
};

/** The routine `made` repeats, the closest kind first; null when it is a new job. */
export const findSameRoutine = <R extends RoutineFacts>(
  made: RoutineFacts,
  routines: Iterable<R>,
  context: RoutineMatchContext = {}
): { routine: R; match: RoutineMatch } | null => {
  let found: { routine: R; match: RoutineMatch } | null = null;
  for (const routine of routines) {
    const match = routineMatch(made, routine, context);
    if (match === "same") return { routine, match };
    if (match != null) found ??= { routine, match };
  }
  return found;
};

/**
 * Each running routine that looks like a copy of another, with the others it
 * repeats. Only ones that both run: pausing one is one of the ways to settle it.
 */
export const duplicateRoutines = <
  R extends RoutineFacts & { id: string; enabled: boolean },
>(
  routines: readonly R[]
): Map<string, R[]> => {
  const running = routines.filter((routine) => routine.enabled);
  const found = new Map<string, R[]>();
  for (const routine of running) {
    const twins = running.filter(
      (other) =>
        other.id !== routine.id &&
        (routineMatch(routine, other) != null ||
          routineMatch(other, routine) != null)
    );
    if (twins.length > 0) found.set(routine.id, twins);
  }
  return found;
};
