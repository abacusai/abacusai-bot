/**
 * What the phone loop and the hosted app share for check-ins: the user's
 * timezone (the server's: from the app's inbox poll, or what `checkins` set),
 * the language check-ins go out in (as the server took it from `checkins`),
 * and the loops due soon, as agenda items. Files under ABACUSAI_BOT_PHONE_DIR.
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

/** The server's zone, or none (null clears it); true when it changed. */
export function writePhoneZone(dir: string, zone: string | null): boolean {
  if (zone != null && !isTimeZone(zone)) return false;
  if (phoneZone(dir) === zone) return false;
  writeJson(zoneFile(dir), zone == null ? {} : { timezone: zone });
  return true;
}

/** The server's own shape: a primary tag and at most one subtag. */
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** A language code the server takes ("es", "pt-BR"), from what the model sent; null for anything else. */
export function languageCode(code: string): string | null {
  const [primary, subtag] = code.trim().split(/[-_]/);
  // A region is upper case ("pt-BR"); a script or variant keeps its own case.
  const region =
    subtag != null && /^[a-z]{2}$/i.test(subtag)
      ? subtag.toUpperCase()
      : subtag;
  const normal = [
    primary?.toLowerCase() ?? "",
    ...(region != null ? [region] : []),
  ].join("-");
  return LANGUAGE_RE.test(normal) ? normal : null;
}

/** The language check-ins go out in, as the server took it; null when never set. */
export function phoneLanguage(dir: string): string | null {
  const code = readJson<{ language?: unknown }>(checkinsFile(dir), {}).language;
  return typeof code === "string" && LANGUAGE_RE.test(code) ? code : null;
}

/** Only what the server accepted (null when it reset it). */
export function writePhoneLanguage(dir: string, code: string | null): void {
  writeJson(
    checkinsFile(dir),
    code != null && LANGUAGE_RE.test(code) ? { language: code } : {}
  );
}

/** Scripts that name one language; Latin, Cyrillic, Arabic, Han and Devanagari do not. */
const SINGLE_LANGUAGE_SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["ko", /\p{Script=Hangul}/u],
  ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["th", /\p{Script=Thai}/u],
  ["el", /\p{Script=Greek}/u],
  ["he", /\p{Script=Hebrew}/u],
];

/** Below this many letters a text says nothing. */
const SCRIPT_MIN_LETTERS = 4;

/**
 * A language code read off the script alone, only where the script names one
 * language. Japanese mixes kana with Han: any kana and no Hangul is Japanese.
 */
export function scriptLanguage(text: string): string | null {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length < SCRIPT_MIN_LETTERS) return null;
  const count = (pattern: RegExp): number =>
    letters.filter((char) => pattern.test(char)).length;
  const han = count(/\p{Script=Han}/u);
  for (const [code, pattern] of SINGLE_LANGUAGE_SCRIPTS) {
    const share = count(pattern) + (code === "ja" ? han : 0);
    if (code === "ja" && count(pattern) === 0) continue;
    if (share / letters.length >= 0.6) return code;
  }
  return null;
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

/** "+05:30" or "Z" as ms east of UTC. */
function fixedOffsetMs(offset: string): number {
  if (offset === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  return (
    sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000
  );
}

/**
 * When a loop's `due` falls, and when its day ends, in epoch ms. `due` is the
 * user's wall clock in their zone (a date alone is DATE_ONLY_HOUR that day);
 * a time with an offset is that instant. With no zone, only that last kind
 * can be placed: a wall time is never read as UTC.
 */
export function dueWindow(
  due: string,
  zone: string | null
): { at: number; endOfDay: number } | null {
  const match = DUE_RE.exec(due.trim());
  if (match == null) return null;
  const [, y, m, d, hh, mm, offset] = match;
  if (zone == null && offset == null) return null;
  const at =
    offset != null
      ? Date.parse(due.trim())
      : zonedWallTime(
          {
            y: Number(y),
            m: Number(m),
            d: Number(d),
            hh: hh != null ? Number(hh) : DATE_ONLY_HOUR,
            mm: mm != null ? Number(mm) : 0,
          },
          zone
        );
  if (Number.isNaN(at)) return null;
  // The day the loop is due on, as the user sees it.
  const shift =
    zone != null ? zoneOffsetMs(zone, at) : fixedOffsetMs(offset ?? "Z");
  const local = new Date(at + shift);
  const lastMinute = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    23,
    59
  );
  const endOfDay =
    zone != null
      ? zonedWallTime(
          {
            y: local.getUTCFullYear(),
            m: local.getUTCMonth() + 1,
            d: local.getUTCDate(),
            hh: 23,
            mm: 59,
          },
          zone
        )
      : lastMinute - shift;
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

const nudgedFile = (dir: string): string => path.join(dir, "nudged.json");

/** Loops already checked in about, as `id|due`: a loop whose due moves comes back. */
const nudgedLoops = (dir: string): Set<string> => {
  const keys = readJson<unknown>(nudgedFile(dir), []);
  return new Set(
    Array.isArray(keys)
      ? keys.filter((key): key is string => typeof key === "string")
      : []
  );
};

/** At most this many retired loops are remembered. */
const NUDGED_KEPT = 200;

const openDueLoops = (
  dir: string
): Array<{ id: string; text: string; due: string }> => {
  const loops = readJson<unknown>(phonePaths(dir).loops, []);
  if (!Array.isArray(loops)) return [];
  return (loops as StoredLoop[]).flatMap((loop) =>
    loop.status === "open" &&
    typeof loop.id === "string" &&
    typeof loop.text === "string" &&
    typeof loop.due === "string"
      ? [{ id: loop.id, text: loop.text, due: loop.due.trim() }]
      : []
  );
};

/**
 * Check-ins went at these times (epoch seconds): a loop that was already due
 * by the latest is taken as checked in about and leaves the agenda for good.
 * The server says what went, not which item it was about.
 */
export function retireNudgedLoops(
  dir: string,
  sentAts: readonly number[],
  zone: string | null
): boolean {
  if (sentAts.length === 0) return false;
  const latest = Math.max(...sentAts) * 1000;
  const nudged = nudgedLoops(dir);
  const before = nudged.size;
  for (const loop of openDueLoops(dir)) {
    const window = dueWindow(loop.due, zone);
    if (window != null && window.at <= latest)
      nudged.add(`${loop.id}|${loop.due}`);
  }
  if (nudged.size === before) return false;
  writeJson(nudgedFile(dir), [...nudged].slice(-NUDGED_KEPT));
  return true;
}

/**
 * Open loops due from now to a week out, soonest first, not yet checked in
 * about: the loop's own words only; `at` says when.
 */
export function dueAgendaItems(
  dir: string,
  now: number,
  zone: string | null
): NudgeAgendaItem[] {
  const nudged = nudgedLoops(dir);
  const items: NudgeAgendaItem[] = [];
  for (const loop of openDueLoops(dir)) {
    if (nudged.has(`${loop.id}|${loop.due}`)) continue;
    const window = dueWindow(loop.due, zone);
    if (window == null || window.endOfDay <= now) continue;
    if (window.at - now > DUE_AHEAD_MS) continue;
    items.push({
      item_id: `loop:${loop.id}`,
      kind: "due",
      // Earlier today is still due: the server fires it once its gate allows.
      at: Math.floor(window.at / 1000),
      expires_at: Math.floor(window.endOfDay / 1000),
      summary: clip(
        loop.text.replace(/\s+/g, " ").trim(),
        NUDGE_SUMMARY_MAX_CHARS
      ),
    });
  }
  return items.sort((a, b) => a.at - b.at);
}
