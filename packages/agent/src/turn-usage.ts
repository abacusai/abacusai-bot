/**
 * What the provider charged for the turn's LAST request, for the log. A prompt
 * cache that stops hitting is invisible otherwise; cached tokens falling to
 * zero mid-conversation means the prefix changed. The request count rides
 * along because a turn with tool rounds makes several requests, and `total`
 * adds them all up: a last request says nothing of what the turn billed.
 * Credits sum every request too (the session adds them per run).
 */
export type TurnTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  model: string | null;
  /** Every request of the turn added up; absent when the last request is all it billed. */
  total?: TurnTokens;
  /** The turn ran on the free models the user chose at the credit wall. */
  lane?: "free";
  /** The free lane's provider that answered. */
  provider?: string;
  /**
   * The Abacus credits every request of the turn billed (abacus-credits.ts):
   * absent with no Abacus request, null when one's charge is unknown.
   */
  credits?: number | null;
};

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type MessageLike = {
  role?: string;
  usage?: UsageLike;
  model?: string;
};

const sameTokens = (left: TurnTokens, right: TurnTokens): boolean =>
  left.input === right.input &&
  left.output === right.output &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite;

export const turnUsage = (
  messages: ReadonlyArray<MessageLike>
): TurnUsage | null => {
  const assistant = messages.filter(
    (message) => message.role === "assistant" && message.usage != null
  );
  const last = assistant.at(-1);
  if (last?.usage == null) return null;
  const n = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const sum = (field: keyof UsageLike): number =>
    assistant.reduce((all, message) => all + n(message.usage?.[field]), 0);
  const lastRequest = {
    input: n(last.usage.input),
    output: n(last.usage.output),
    cacheRead: n(last.usage.cacheRead),
    cacheWrite: n(last.usage.cacheWrite),
  };
  const total = {
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
  };
  return {
    ...lastRequest,
    requests: assistant.length,
    model: typeof last.model === "string" ? last.model : null,
    ...(sameTokens(total, lastRequest) ? {} : { total }),
  };
};

/**
 * A turn can take several runs (a stall's re-ask, a move to another model):
 * the last run's last request and count stand, and what the runs billed adds up.
 */
export const addRunUsage = (
  turn: TurnUsage | null,
  run: TurnUsage | null
): TurnUsage | null => {
  if (turn == null || run == null) return run ?? turn;
  const before = turn.total ?? turn;
  const now = run.total ?? run;
  const total = {
    input: before.input + now.input,
    output: before.output + now.output,
    cacheRead: before.cacheRead + now.cacheRead,
    cacheWrite: before.cacheWrite + now.cacheWrite,
  };
  const { total: _runTotal, ...lastRun } = run;
  return sameTokens(total, run) ? lastRun : { ...lastRun, total };
};

/** How much context the turn's last request carried. */
