/**
 * `browser_task`'s handle on the session's checkout. The checkout itself (its
 * stage, the stop it waits on, whether the user's approval is live) lives in
 * the browser, beside the Pay guard and the vault that enforce it; this asks
 * it through `browser_checkout`, a tool no model is offered, and keeps the
 * last answer for wording the result. Nothing here decides a stage.
 */

/** Keep in step with CHECKOUT_STATE_PREFIX in the desktop's vault/checkout-tools.ts. */
export const CHECKOUT_STATE_PREFIX = "checkout-state: ";

/** The host's internal tool; never advertised to a model. */
export const BROWSER_CHECKOUT_TOOL_NAME = "browser_checkout";

/** The sub-agent's stop, served by the browser. */
export const BROWSER_PAUSE_TOOL_NAME = "browser_pause";

export type CheckoutStage =
  | "search"
  | "select"
  | "details"
  | "login"
  | "review"
  | "awaiting_approval"
  | "card_fill"
  | "bank_otp"
  | "confirmation"
  | "failed"
  | "abandoned";

export type PauseNeed =
  | "details"
  | "login"
  | "code"
  | "payment"
  | "captcha"
  | "choose";

/** A stop as the browser recorded it; page-derived text is already sanitized there. */
export interface CheckoutPause {
  need: PauseNeed | "user";
  fields: string[];
  site: string | null;
  /** For a payment: the total the browser read off the page. */
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  cvvRequired: boolean;
  summary: string;
  mediaId: string | null;
}

export interface CheckoutState {
  stage: CheckoutStage;
  paused: CheckoutPause | null;
  /** On a resume: whether the user's approval of the paused total is live. */
  approved?: boolean;
}

const STAGES: ReadonlySet<string> = new Set([
  "search",
  "select",
  "details",
  "login",
  "review",
  "awaiting_approval",
  "card_fill",
  "bank_otp",
  "confirmation",
  "failed",
  "abandoned",
]);

/** The checkout state a browser result ends with, or null when it has none. */
export function readCheckoutState(text: string): CheckoutState | null {
  const line = text
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(CHECKOUT_STATE_PREFIX));
  if (line == null) return null;
  try {
    const parsed = JSON.parse(
      line.slice(CHECKOUT_STATE_PREFIX.length)
    ) as Partial<CheckoutState>;
    if (typeof parsed.stage !== "string" || !STAGES.has(parsed.stage))
      return null;
    return {
      stage: parsed.stage,
      paused:
        parsed.paused != null && typeof parsed.paused === "object"
          ? parsed.paused
          : null,
      ...(typeof parsed.approved === "boolean"
        ? { approved: parsed.approved }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Calls `browser_checkout` with these arguments; null when the browser has no such tool. */
export type HostCheckoutCall = (
  args: Record<string, unknown>
) => Promise<{ text: string; isError: boolean } | null>;

const CHECKOUT_TOKEN_ENV = "ABACUSAI_BOT_CHECKOUT_TOKEN";
let checkoutToken: string | null | undefined;

/**
 * The capability the desktop handed this process for `browser_checkout`.
 * Taken out of the environment on first read, so no shell the agent starts
 * inherits it.
 */
function takeCheckoutToken(): string | null {
  if (checkoutToken === undefined) {
    const value = (process.env[CHECKOUT_TOKEN_ENV] ?? "").trim();
    checkoutToken = value.length > 0 ? value : null;
    delete process.env[CHECKOUT_TOKEN_ENV];
  }
  return checkoutToken;
}

/** `call` with this process's checkout capability on every request; null without one. */
export function withCheckoutToken(
  call: HostCheckoutCall
): HostCheckoutCall | null {
  const token = takeCheckoutToken();
  return token == null ? null : (args) => call({ ...args, token });
}

export type RunEnd =
  | "completed"
  | "turn-limit"
  | "timeout"
  | "error"
  | "provider-error"
  | "aborted";

export class CheckoutRun {
  private last: CheckoutState = { stage: "search", paused: null };

  constructor(private readonly call: HostCheckoutCall | null) {}

  /** The browser's last word on the checkout. */
  get state(): CheckoutState {
    return this.last;
  }

  /** A browser result that carried the checkout's state (a pause). */
  note(state: CheckoutState): void {
    this.last = state;
  }

  private async ask(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; reason: string }> {
    const result = await this.call?.(args).catch(() => null);
    if (result == null) return { ok: false, reason: "no-host" };
    const state = readCheckoutState(result.text);
    if (state != null) this.last = state;
    return {
      ok: !result.isError,
      reason: result.text
        .split("\n")
        .filter((line) => !line.startsWith(CHECKOUT_STATE_PREFIX))
        .join(" ")
        .trim(),
    };
  }

  /** A fresh run: whatever was under way is let go. */
  async start(): Promise<void> {
    if ((await this.ask({ action: "start" })).reason === "no-host")
      this.last = { stage: "search", paused: null };
  }

  /**
   * Continue the run that stopped for the user. `approved` is the browser's
   * answer: true only when the paused payment's approval is live.
   */
  async resume(
    options: { answered?: boolean } = {}
  ): Promise<{ ok: true; approved: boolean } | { ok: false; reason: string }> {
    const answer = await this.ask({
      action: "resume",
      ...(options.answered === true ? { answered: true } : {}),
    });
    if (answer.reason === "no-host") {
      // No browser checkout to ask: only an unstructured stop continues.
      if (this.last.paused == null)
        return { ok: false, reason: "Nothing is paused to continue." };
      this.last = { stage: this.last.stage, paused: null };
      return { ok: true, approved: false };
    }
    return answer.ok
      ? { ok: true, approved: this.last.approved === true }
      : { ok: false, reason: answer.reason };
  }

  /** A run's "NEEDS USER:" line: the same stop, unstructured. */
  async hold(summary: string): Promise<void> {
    if ((await this.ask({ action: "hold", summary })).reason === "no-host")
      this.last = {
        stage: this.last.stage,
        paused: {
          need: "user",
          fields: [],
          site: null,
          amount: null,
          currency: null,
          merchant: null,
          cvvRequired: false,
          summary,
          mediaId: null,
        },
      };
  }

  async finish(end: RunEnd): Promise<void> {
    await this.ask({ action: "finish", end });
  }

  /** The paused run was let go (it waited too long). */
  async abandon(): Promise<void> {
    if ((await this.ask({ action: "abandon" })).reason === "no-host")
      this.last = { stage: "abandoned", paused: null };
  }
}
