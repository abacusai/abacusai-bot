/**
 * What every call to Abacus reports, and what a background caller asks
 * before it goes: the connectivity owner (connectivity-service.ts) answers
 * once installed. No electron here, so anything may import it.
 */

/** The connectivity owner, as the call sites see it. */
export interface AbacusCallSink {
  answered(): void;
  failed(source: string, error: unknown, startedAt: number): void;
  readonly backgroundReady: boolean;
  untilBackgroundReady(signal?: AbortSignal): Promise<void>;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether a thrown error means the request never got an answer: no network,
 * no DNS, a refused or dropped connection, a timeout. An HTTP status is an
 * answer, whatever it says.
 */
export const isNetworkFailure = (error: unknown): boolean => {
  if (error == null || typeof error !== "object") return false;
  const { name, message, code, cause } = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
  if (typeof message === "string") {
    if (message === "fetch failed" || message.includes("net::ERR_"))
      return true;
    if (/operation was aborted|timed out|socket hang up/i.test(message))
      return true;
  }
  return cause != null && cause !== error && isNetworkFailure(cause);
};

let sink: AbacusCallSink | null = null;

/** Install the owner; until then the reporters are no-ops and nothing is held. */
export const installAbacusCallSink = (owner: AbacusCallSink): void => {
  sink = owner;
};

/** A call to Abacus got an HTTP answer. */
export const abacusCallAnswered = (): void => sink?.answered();

/** A call to Abacus that started at `startedAt` threw `error`. */
export const abacusCallFailed = (
  source: string,
  error: unknown,
  startedAt: number
): void => sink?.failed(source, error, startedAt);

/** Whether a background call to Abacus may go out now. */
export const abacusBackgroundReady = (): boolean =>
  sink?.backgroundReady ?? true;

/** Resolves once a background call may go out, or when `signal` aborts. */
export const untilAbacusBackgroundReady = (
  signal?: AbortSignal
): Promise<void> => sink?.untilBackgroundReady(signal) ?? Promise.resolve();
