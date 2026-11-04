/**
 * What the provider charged for the turn's LAST request, for the log. A prompt
 * cache that stops hitting is invisible otherwise; cached tokens falling to
 * zero mid-conversation means the prefix changed. The request count rides
 * along because a turn with tool rounds makes several requests. Credits are
 * the exception: they sum every request (the session adds them per run).
 */
export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  model: string | null;
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
  return {
    input: n(last.usage.input),
    output: n(last.usage.output),
    cacheRead: n(last.usage.cacheRead),
    cacheWrite: n(last.usage.cacheWrite),
    requests: assistant.length,
    model: typeof last.model === "string" ? last.model : null,
  };
};
