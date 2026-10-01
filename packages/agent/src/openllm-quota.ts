/**
 * What each free source has spent this minute and this day, so the pool
 * skips a model before its provider refuses it instead of after. Counted per
 * model, or per provider when its limits are account-wide (FreeSource).
 * Days follow UTC, where the providers reset theirs.
 *
 * The published limits are free-tier numbers. A call that succeeds while
 * the ledger thought the window spent proves the key is not on that tier,
 * and the key is never held back again.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "./config.js";
import { freeSource, type WindowLimits } from "./free-sources.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface QuotaEntry {
  /** Start of the minute counted, ms since epoch. */
  minute: number;
  minuteCalls: number;
  minuteTokens: number;
  /** Start of the UTC day counted. */
  day: number;
  dayCalls: number;
  dayTokens: number;
  /** The key answered past the free limits: it is not on the free tier. */
  unmetered?: boolean;
}

export type QuotaEntries = Record<string, QuotaEntry>;

export interface QuotaStore {
  read(): QuotaEntries;
  /** Apply `update` to the entries as they are on disk now. */
  update(update: (entries: QuotaEntries) => QuotaEntries): void;
}

/** Where a model's calls are counted: the model, or its whole account. */
export const quotaKey = (provider: string, modelId: string): string =>
  freeSource(provider)?.accountWide === true
    ? provider
    : `${provider}/${modelId}`;

const startOfMinute = (at: number): number => at - (at % MINUTE_MS);
const startOfDay = (at: number): number => at - (at % DAY_MS);

const empty = (now: number): QuotaEntry => ({
  minute: startOfMinute(now),
  minuteCalls: 0,
  minuteTokens: 0,
  day: startOfDay(now),
  dayCalls: 0,
  dayTokens: 0,
});

/** The entry as of `now`: a window that has passed counts nothing. */
const current = (entry: QuotaEntry | undefined, now: number): QuotaEntry => {
  const fresh = empty(now);
  if (entry == null) return fresh;
  const sameMinute = entry.minute === fresh.minute;
  const sameDay = entry.day === fresh.day;
  return {
    minute: fresh.minute,
    minuteCalls: sameMinute ? entry.minuteCalls : 0,
    minuteTokens: sameMinute ? entry.minuteTokens : 0,
    day: fresh.day,
    dayCalls: sameDay ? entry.dayCalls : 0,
    dayTokens: sameDay ? entry.dayTokens : 0,
    ...(entry.unmetered === true ? { unmetered: true } : {}),
  };
};

/** When the spent window reopens, or 0 when nothing is spent. */
const reopensAt = (entry: QuotaEntry, limits: WindowLimits): number => {
  const spent = (used: number, limit: number | undefined): boolean =>
    limit != null && used >= limit;
  if (spent(entry.dayCalls, limits.rpd) || spent(entry.dayTokens, limits.tpd))
    return entry.day + DAY_MS;
  if (
    spent(entry.minuteCalls, limits.rpm) ||
    spent(entry.minuteTokens, limits.tpm)
  )
    return entry.minute + MINUTE_MS;
  return 0;
};

export class QuotaLedger {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly store: QuotaStore = memoryQuotaStore()
  ) {}

  /** A call to this model came back with `tokens` used. */
  record(provider: string, modelId: string, tokens: number): void {
    const limits = freeSource(provider)?.limits;
    if (limits == null) return;
    const key = quotaKey(provider, modelId);
    const now = this.now();
    this.store.update((entries) => {
      const entry = current(entries[key], now);
      // It answered though the window was spent: not a free-tier key.
      const unmetered =
        entry.unmetered === true || reopensAt(entry, limits) > 0;
      return {
        ...entries,
        [key]: {
          ...entry,
          minuteCalls: entry.minuteCalls + 1,
          minuteTokens: entry.minuteTokens + Math.max(0, tokens),
          dayCalls: entry.dayCalls + 1,
          dayTokens: entry.dayTokens + Math.max(0, tokens),
          ...(unmetered ? { unmetered: true } : {}),
        },
      };
    });
  }

  /** When this model may be asked again, or 0 when it may be asked now. */
  blockedUntil(provider: string, modelId: string): number {
    const limits = freeSource(provider)?.limits;
    if (limits == null) return 0;
    const now = this.now();
    const entry = current(this.store.read()[quotaKey(provider, modelId)], now);
    if (entry.unmetered === true) return 0;
    const at = reopensAt(entry, limits);
    return at > now ? at : 0;
  }
}

export function memoryQuotaStore(): QuotaStore {
  let entries: QuotaEntries = {};
  return {
    read: () => entries,
    update(update) {
      entries = update(entries);
    },
  };
}

const STORE_FILE = "openllm-quota.json";

const isEntry = (value: unknown): value is QuotaEntry => {
  const entry = value as QuotaEntry | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    [
      entry.minute,
      entry.minuteCalls,
      entry.minuteTokens,
      entry.day,
      entry.dayCalls,
      entry.dayTokens,
    ].every((field) => typeof field === "number")
  );
};

/**
 * Shared by every agent process, like the cooldowns beside it. Each update
 * re-reads the file, so concurrent chats add to each other's counts; a lost
 * write undercounts by one call, which the provider's own 429 still covers.
 */
export function fileQuotaStore(
  file: string = path.join(abacusBotDir(), STORE_FILE)
): QuotaStore {
  const read = (): QuotaEntries => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (pair): pair is [string, QuotaEntry] => isEntry(pair[1])
        )
      );
    } catch {
      return {};
    }
  };
  return {
    read,
    update(update) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(update(read())), "utf8");
        fs.renameSync(temporary, file);
      } catch {
        // Advisory: the provider's own refusal still stands behind it.
      }
    },
  };
}
