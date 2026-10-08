/**
 * What the phone loop and the hosted app share for check-ins: the user's
 * timezone (the server's, written by the app's inbox poll), the language
 * check-ins go out in (set with `checkins`), and the loops due soon, as
 * agenda items. Files under ABACUSAI_BOT_PHONE_DIR; each has one writer.
 */
import path from "path";

import { DAY_MS, phonePaths, readJson, writeJson } from "./phone-config.js";

/** One thing the server may check in about; times in epoch seconds. */
export interface NudgeAgendaItem {
  item_id: string;
  kind: "waiting" | "due" | "connect";
  at: number;
  expires_at?: number;
  summary: string;
}

/** The server keeps a summary to this many characters. */
export const NUDGE_SUMMARY_MAX_CHARS = 200;

const zoneFile = (dir: string): string => path.join(dir, "zone.json");
const checkinsFile = (dir: string): string => path.join(dir, "checkins.json");

/** An IANA zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  if (zone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The user's zone, or null when the server has none. */
export function phoneZone(dir: string): string | null {
  const zone = readJson<{ timezone?: unknown }>(zoneFile(dir), {}).timezone;
  return typeof zone === "string" && isTimeZone(zone) ? zone : null;
}

/** True when it changed. */
export function writePhoneZone(dir: string, zone: string): boolean {
  if (!isTimeZone(zone) || phoneZone(dir) === zone) return false;
  writeJson(zoneFile(dir), { timezone: zone });
  return true;
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A language code ("es", "pt-BR"), never a name or free text. */
export const isLanguageCode = (code: string): boolean => LANGUAGE_RE.test(code);

/** The language check-ins go out in, or null when it was never set. */
export function phoneLanguage(dir: string): string | null {
  const code = readJson<{ language?: unknown }>(checkinsFile(dir), {}).language;
  return typeof code === "string" && isLanguageCode(code) ? code : null;
}

export function writePhoneLanguage(dir: string, code: string): void {
  if (isLanguageCode(code)) writeJson(checkinsFile(dir), { language: code });
}

/** The zone's offset from UTC at `at`, in ms. */
function zoneOffsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string): number =>
    Number(parts.find((piece) => piece.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return wall - (at - (at % 1000));
}

/** A wall-clock time in `zone` (or UTC with none), as epoch ms. */
export function zonedWallTime(
  wall: { y: number; m: number; d: number; hh: number; mm: number },
  zone: string | null
): number {
  const utc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm);
  if (zone == null) return utc;
  // Twice: the first guess may sit across a DST change from the answer.
  const first = utc - zoneOffsetMs(zone, utc);
  return utc - zoneOffsetMs(zone, first);
}

/** A loop with only a date is due at this local hour. */
const DATE_ONLY_HOUR = 10;
/** How far ahead loops go on the agenda. */
const DUE_AHEAD_MS = 7 * DAY_MS;

const DUE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * When a loop's `due` falls, and when its day ends, in epoch ms. A time with
 * an offset is that instant; without one it is the user's wall clock; a date
 * alone is DATE_ONLY_HOUR that day.
 */
export function dueWindow(
  due: string,
  zone: string | null
): { at: number; endOfDay: number } | null {
  const match = DUE_RE.exec(due.trim());
  if (match == null) return null;
  const [, y, m, d, hh, mm, offset] = match;
  const day = { y: Number(y), m: Number(m), d: Number(d) };
  const at =
    offset != null
      ? Date.parse(due.trim())
      : zonedWallTime(
          {
            ...day,
            hh: hh != null ? Number(hh) : DATE_ONLY_HOUR,
            mm: mm != null ? Number(mm) : 0,
          },
          zone
        );
  if (Number.isNaN(at)) return null;
  // The day the loop is due on, as the user sees it.
  const local = new Date(at + (zone != null ? zoneOffsetMs(zone, at) : 0));
  const endOfDay = zonedWallTime(
    {
      y: local.getUTCFullYear(),
      m: local.getUTCMonth() + 1,
      d: local.getUTCDate(),
      hh: 23,
      mm: 59,
    },
    zone
  );
  return { at, endOfDay };
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

interface StoredLoop {
  id?: unknown;
  text?: unknown;
  due?: unknown;
  status?: unknown;
}

/**
 * Open loops due from now to a week out, soonest first: the loop's own
 * words (what the user asked to track) and when it is due, nothing else.
 */
export function dueAgendaItems(
  dir: string,
  now: number,
  zone: string | null
): NudgeAgendaItem[] {
  const loops = readJson<unknown>(phonePaths(dir).loops, []);
  if (!Array.isArray(loops)) return [];
  const items: NudgeAgendaItem[] = [];
  for (const loop of loops as StoredLoop[]) {
    if (
      loop.status !== "open" ||
      typeof loop.id !== "string" ||
      typeof loop.text !== "string" ||
      typeof loop.due !== "string"
    )
      continue;
    const window = dueWindow(loop.due, zone);
    if (window == null || window.endOfDay <= now) continue;
    if (window.at - now > DUE_AHEAD_MS) continue;
    const when = ` (due ${loop.due.trim()})`;
    items.push({
      item_id: `loop:${loop.id}`,
      kind: "due",
      // Earlier today is still due: the server fires it once its gate allows.
      at: Math.floor(window.at / 1000),
      expires_at: Math.floor(window.endOfDay / 1000),
      summary: `${clip(loop.text.replace(/\s+/g, " ").trim(), NUDGE_SUMMARY_MAX_CHARS - when.length)}${when}`,
    });
  }
  return items.sort((a, b) => a.at - b.at);
}
