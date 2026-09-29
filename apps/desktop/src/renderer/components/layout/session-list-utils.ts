/**
 * Pure helpers behind the sidebar's session list: fuzzy search, age labels, and
 * the day/month buckets. Free of React and i18n: labels come back as tokens.
 */

export interface FuzzyMatch {
  /** Higher is a better match. Only meaningful relative to other matches. */
  score: number;
  /** Indices in the haystack that the query matched, for highlighting. */
  positions: number[];
}

const WORD_BOUNDARY = /[^\p{L}\p{N}]/u;

/**
 * Subsequence match ("wsp" finds "workspace panel"). Scoring rewards
 * consecutive characters and word starts; null when not a subsequence.
 */
export const fuzzyMatch = (query: string, text: string): FuzzyMatch | null => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { score: 0, positions: [] };

  const haystack = (text ?? "").toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -2;

  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index === -1) return null;

    score += 1;
    if (index === previousIndex + 1) score += 5;
    if (index === 0 || WORD_BOUNDARY.test(haystack[index - 1] ?? ""))
      score += 3;

    positions.push(index);
    previousIndex = index;
    cursor = index + 1;
  }

  // A short label that matched is a tighter hit than a long one that matched the
  // same characters incidentally.
  return { score: score - haystack.length * 0.01, positions };
};

/** Splits `text` into runs, flagging the ones the search matched. */
export const highlightSegments = (
  text: string,
  positions: number[]
): { text: string; matched: boolean }[] => {
  if (positions.length === 0) return [{ text, matched: false }];

  const matchedIndices = new Set(positions);
  const segments: { text: string; matched: boolean }[] = [];

  for (let index = 0; index < text.length; index++) {
    const matched = matchedIndices.has(index);
    const last = segments[segments.length - 1];
    if (last != null && last.matched === matched) {
      last.text += text[index];
    } else {
      segments.push({ text: text[index], matched });
    }
  }

  return segments;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type SessionAge =
  | { unit: "now" }
  | { unit: "minutes" | "hours" | "days"; count: number };

/**
 * How long ago something happened, at the coarsest unit that still says
 * something: "3m", "16h", "54d". The caller words it.
 */
export const sessionAge = (
  timestamp: string | number | null | undefined,
  nowMs: number
): SessionAge | null => {
  const then =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
  if (Number.isNaN(then)) return null;

  const elapsed = Math.max(0, nowMs - then);
  if (elapsed < MINUTE_MS) return { unit: "now" };
  if (elapsed < HOUR_MS)
    return { unit: "minutes", count: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS)
    return { unit: "hours", count: Math.floor(elapsed / HOUR_MS) };
  return { unit: "days", count: Math.floor(elapsed / DAY_MS) };
};

/**
 * `today` carries no header: the freshest sessions should read as the list
 * itself, not as a bucket. Everything else is labelled.
 */
export type SessionBucket =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "month"; monthStart: number; sameYear: boolean };

export interface SessionGroup<T> {
  /** Stable across renders, safe as a React key. */
  id: string;
  bucket: SessionBucket;
  sessions: T[];
}

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * Buckets sessions into today / yesterday / one group per calendar month,
 * newest first. Months rather than weeks: "June" is a landmark in a way "2
 * weeks ago" isn't.
 */
export const groupSessionsByDay = <T>(
  sessions: T[],
  getTimestamp: (session: T) => string | number | null | undefined,
  nowMs: number
): SessionGroup<T>[] => {
  const todayStart = startOfDay(nowMs);
  const yesterdayStart = startOfDay(todayStart - DAY_MS);
  const currentYear = new Date(nowMs).getFullYear();

  const groups = new Map<string, SessionGroup<T>>();
  const sortKeys = new Map<string, number>();

  const sorted = [...sessions].sort(
    (a, b) => timestampOf(b, getTimestamp) - timestampOf(a, getTimestamp)
  );

  for (const session of sorted) {
    const at = timestampOf(session, getTimestamp);

    let id: string;
    let bucket: SessionBucket;
    let sortKey: number;

    if (at >= todayStart) {
      id = "today";
      bucket = { kind: "today" };
      sortKey = todayStart;
    } else if (at >= yesterdayStart) {
      id = "yesterday";
      bucket = { kind: "yesterday" };
      sortKey = yesterdayStart;
    } else {
      const date = new Date(at);
      const monthStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        1
      ).getTime();
      id = `month-${monthStart}`;
      bucket = {
        kind: "month",
        monthStart,
        sameYear: date.getFullYear() === currentYear,
      };
      sortKey = monthStart;
    }

    const existing = groups.get(id);
    if (existing != null) {
      existing.sessions.push(session);
    } else {
      groups.set(id, { id, bucket, sessions: [session] });
      sortKeys.set(id, sortKey);
    }
  }

  return [...groups.values()].sort(
    (a, b) => (sortKeys.get(b.id) ?? 0) - (sortKeys.get(a.id) ?? 0)
  );
};

/** Undated sessions sort to the bottom rather than to 1970. */
const timestampOf = <T>(
  session: T,
  getTimestamp: (session: T) => string | number | null | undefined
): number => {
  const raw = getTimestamp(session);
  const parsed = typeof raw === "number" ? raw : Date.parse(raw ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * How a chat list stamps its rows: the time today, the day before that, as a
 * phone's message list does. The workspace tree's compact ages ("17m") answer
 * a different question: how stale, not when. A token; the caller words it.
 */
export type ChatStamp =
  | { kind: "time" }
  | { kind: "yesterday" }
  | { kind: "weekday" }
  | { kind: "date"; sameYear: boolean };

export const chatStamp = (
  at: number | null | undefined,
  now: number
): ChatStamp | null => {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const day = 24 * 60 * 60 * 1000;

  // Ahead of "now" is a clock that moved, not a message from the future.
  if (at >= today) return { kind: "time" };
  if (at >= today - day) return { kind: "yesterday" };
  // A week back stops being "last Tuesday" and starts being a date.
  if (at >= today - 6 * day) return { kind: "weekday" };

  return {
    kind: "date",
    sameYear: new Date(at).getFullYear() === new Date(now).getFullYear(),
  };
};

/**
 * How the Sessions list is dated: today, yesterday, a count of days, then the
 * date. Days rather than months because this is the list scanned for this
 * week's work; the workspace tree's month buckets serve the longer look back.
 */
export type SidebarDateBucket =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "daysAgo"; count: number }
  | { kind: "date"; at: number; sameYear: boolean };

export interface SidebarSessionGroup<T> {
  /** Stable across renders, safe as a React key. */
  id: string;
  bucket: SidebarDateBucket;
  sessions: T[];
}

/** The freshest rows carry no header: the top should read as the list. */

export const RECENT_ROWS_WITHOUT_HEADER = 10;

/** Past this many days back, "N days ago" stops helping and the date takes over. */
const DAYS_AGO_LIMIT = 4;

export const groupSessionsForSidebar = <T>(
  sessions: T[],
  getTimestamp: (session: T) => string | number | null | undefined,
  nowMs: number
): SidebarSessionGroup<T>[] => {
  const todayStart = startOfDay(nowMs);
  const currentYear = new Date(nowMs).getFullYear();
  const groups: SidebarSessionGroup<T>[] = [];

  const sorted = [...sessions].sort(
    (a, b) => timestampOf(b, getTimestamp) - timestampOf(a, getTimestamp)
  );

  for (const session of sorted) {
    const at = timestampOf(session, getTimestamp);
    const daysBack = Math.floor((todayStart - startOfDay(at)) / DAY_MS);

    let id: string;
    let bucket: SidebarDateBucket;
    if (daysBack <= 0) {
      id = "today";
      bucket = { kind: "today" };
    } else if (daysBack === 1) {
      id = "yesterday";
      bucket = { kind: "yesterday" };
    } else if (daysBack <= DAYS_AGO_LIMIT) {
      id = `days-${daysBack}`;
      bucket = { kind: "daysAgo", count: daysBack };
    } else {
      const day = startOfDay(at);
      id = `date-${day}`;
      bucket = {
        kind: "date",
        at: day,
        sameYear: new Date(at).getFullYear() === currentYear,
      };
    }

    const last = groups[groups.length - 1];
    if (last != null && last.id === id) last.sessions.push(session);
    else groups.push({ id, bucket, sessions: [session] });
  }

  return groups;
};
