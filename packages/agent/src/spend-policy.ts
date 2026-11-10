/**
 * How much one turn or run may spend, by who pays and who is waiting: the one
 * table the agent's spend governor (extensions/spend-governor.ts) enforces and
 * the desktop's routine runner reads. Numbers only; no state.
 */

/** Who is waiting on the work, read from what the host passes at spawn. */
export type SpendKind =
  /** A desktop chat with the user in it. */
  | "attended"
  /** A chat whose user waits in a messaging app. */
  | "phone"
  /** A routine's or a hosted run: nobody is watching. */
  | "routine"
  /** A follow-up nobody asked for (the verify loop's repair). */
  | "unasked"
  /** Hidden memory upkeep after a turn. */
  | "memory";

/** Who pays for a request, from its model. */
export type SpendLane =
  | "abacus-billed"
  | "abacus-free"
  | "pool"
  | "own-key"
  | "local";

export interface SpendLimit {
  /** Model calls one run may make; null inherits the caller's. */
  calls: number | null;
  /** Time from the user's message; null inherits. */
  timeMs: number | null;
}

const MINUTE = 60_000;

export const SPEND_LIMITS: Readonly<Record<SpendKind, SpendLimit>> = {
  attended: { calls: 250, timeMs: 60 * MINUTE },
  phone: { calls: 250, timeMs: 30 * MINUTE },
  routine: { calls: 150, timeMs: 30 * MINUTE },
  unasked: { calls: null, timeMs: null },
  memory: { calls: 20, timeMs: 5 * MINUTE },
};

/**
 * Where an attended turn on a free plan stops to ask the user before it
 * spends more: a quarter of what is left or a fifth of the plan, whichever is
 * smaller, never under 50. Paid plans have no per-turn check-in.
 */
export const checkInCredits = (
  remaining: number,
  planCredits: number
): number => Math.max(50, Math.min(remaining * 0.25, planCredits * 0.2));

/** What a follow-up nobody asked for may spend: a tenth of its turn, at least 10. */
export const unaskedCredits = (turnCredits: number): number =>
  Math.max(10, turnCredits * 0.1);

/** Hidden memory upkeep's credits; skipped altogether in reserve. */
export const MEMORY_CREDITS = 10;

/**
 * Near the end of the credits: under a tenth of the plan, or under three of
 * this session's typical turns, whichever is more.
 */
export const reserveStarts = (
  remaining: number,
  planCredits: number,
  medianTurn: number
): boolean => remaining < Math.max(planCredits * 0.1, medianTurn * 3);

/** Whole turns the balance covers at the session's typical cost; null before any is known. */
export const turnsLeft = (
  remaining: number,
  medianTurn: number
): number | null =>
  medianTurn > 0 ? Math.max(0, Math.floor(remaining / medianTurn)) : null;

/** The model hears the estimate again only when it crosses one of these. */
const TURN_BUCKETS = [1, 2, 3, 5, 10, 20] as const;

export const turnsBucket = (turns: number | null): number =>
  turns == null ? -1 : TURN_BUCKETS.filter((edge) => turns >= edge).length;

/** A billed chat's context ceiling: past it the history is summarized. */
export const BILLED_CONTEXT_CAP = 160_000;
/** A routine's: its whole chat replays every run. */
export const ROUTINE_CONTEXT_CAP = 80_000;
/** The share of a model's window kept free in every lane. */
export const CONTEXT_WINDOW_SHARE = 0.8;
/** Below this the session would thrash summaries instead of working. */
export const CONTEXT_CAP_FLOOR = 20_000;

/**
 * The most a request may carry: a share of the window, the payer's cap, and
 * any limit a provider stated in a refusal this session.
 */
export const contextCap = ({
  window,
  lane,
  kind,
  learned,
}: {
  window: number;
  lane: SpendLane;
  kind: SpendKind;
  learned?: number | null;
}): number => {
  const laneCap =
    kind === "routine"
      ? ROUTINE_CONTEXT_CAP
      : lane === "abacus-billed"
        ? BILLED_CONTEXT_CAP
        : Number.POSITIVE_INFINITY;
  const cap = Math.min(
    Math.floor(window * CONTEXT_WINDOW_SHARE),
    laneCap,
    learned ?? Number.POSITIVE_INFINITY
  );
  return Math.max(Math.min(CONTEXT_CAP_FLOOR, window), cap);
};

/** One request that billed more than this share of the plan summarizes before the next. */
export const COSTLY_REQUEST_SHARE = 0.02;

/**
 * The limit a provider named when it refused a request for size: "Limit
 * 6000", "maximum context length is 200000", "exceeds the 131072 token
 * limit". Null when the text names none.
 */
export const statedTokenLimit = (raw: string): number | null => {
  const text = raw.toLowerCase().replace(/,/g, "");
  const match =
    /\blimit:?\s*(\d{3,})/.exec(text) ??
    /maximum (?:context length|input tokens?)(?: is)?:?\s*(\d{3,})/.exec(
      text
    ) ??
    /context (?:window|length) (?:of|is)\s*(\d{3,})/.exec(text) ??
    /(\d{3,}) tokens? (?:limit|maximum)/.exec(text);
  const value = match == null ? NaN : Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
};
