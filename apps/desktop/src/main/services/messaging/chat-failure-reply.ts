import { providerDisplayName } from "@abacus-ai/contract/settings";

/**
 * What a chat is told when a turn failed, on every platform and lane. Never
 * the raw error: provider JSON and credit-wall text reached phones, and other
 * people's chats, as the bot's reply. The pane and the log keep the real text.
 */

/** The user's own chat on the platform, or someone they auto-reply to. */
export type ChatKind = "own" | "other";

/** The signed-in Abacus plan as last read; unknown when never read. */
export type AccountKind = "free" | "paid" | "unknown";

/** What the gateway reads off a failed turn's error event. */
export interface TurnFailure {
  code?: string;
  actions?: ReadonlyArray<{ type: string; provider?: string; cause?: string }>;
}

/**
 * A failure as the chat hears it. The first three are the ones whose line
 * sells a way out, which the throttle holds to once per window.
 */
export type FailureKind =
  | "upgrade-abacus"
  | "own-key"
  | "free-pool-out"
  | "model-unavailable"
  | "generic";

/** What a phone hears when the desktop has no model to answer with. */
export const NO_MODEL_REPLY =
  "The desktop app is not signed in to Abacus.AI right now. Open the app and sign in, then message me again.";

const GENERIC_REPLY =
  "Something went wrong on my side, so I couldn't finish that. Please try again in a moment.";

/** The plans page, for an account the upgrade page does not cover. */
const ABACUS_PLANS_URL = "https://apps.abacus.ai/chatllm/choose-plan/";

const ABACUS_AGENT_URL = "https://apps.abacus.ai/chatllm";

const ownKeyAction = (error: TurnFailure) =>
  error.actions?.find((action) => action.type === "own-key-unavailable");

export const failureKind = (error: TurnFailure): FailureKind => {
  const types = new Set(error.actions?.map((action) => action.type));
  if (types.has("upgrade-abacus")) return "upgrade-abacus";
  if (ownKeyAction(error)?.provider != null) return "own-key";
  // Before the sign-in line: a shut free pool reports model_unavailable too.
  if (types.has("free-pool-out")) return "free-pool-out";
  if (error.code === "model_unavailable") return "model-unavailable";
  return "generic";
};

/** Whether the line for this failure carries the upgrade page. */
export const wantsUpgradeUrl = (
  error: TurnFailure,
  account: AccountKind
): boolean => {
  const kind = failureKind(error);
  if (kind === "upgrade-abacus" || kind === "own-key")
    return account === "free";
  return kind === "free-pool-out" && account !== "paid";
};

const ownKeyLead = (error: TurnFailure): string => {
  const action = ownKeyAction(error);
  const provider = providerDisplayName(action?.provider ?? "");
  if (action?.cause === "credit")
    return `Your ${provider} key is out of credit.`;
  if (action?.cause === "rate_limit")
    return `Your ${provider} key hit its rate limit.`;
  return `${provider} isn't responding right now.`;
};

/**
 * The single place a failed turn becomes chat words. Someone else's chat gets
 * nothing: no error, no offer, only what the agent itself had produced. With
 * `repeat`, the offer already went to this chat inside the throttle window, so
 * the line shrinks to a reminder.
 */
export const chatReplyForFailure = (
  error: TurnFailure,
  chatKind: ChatKind,
  account: AccountKind,
  upgradeUrl: string | null,
  repeat = false
): string | null => {
  if (chatKind === "other") return null;
  const link = upgradeUrl ?? ABACUS_PLANS_URL;
  switch (failureKind(error)) {
    case "upgrade-abacus": {
      // Why the credit gate refused, when the agent could tell.
      const cause = error.actions?.find(
        (action) => action.type === "upgrade-abacus"
      )?.cause;
      if (cause === "expired")
        return repeat
          ? `Still paused: ${link}`
          : `I've paused because your free credits have expired. Upgrade to Basic for $7 your first month and I'll pick right back up: ${link}`;
      if (account === "free")
        return repeat
          ? `Still paused: ${link}`
          : `I've paused because your free credits have run out. Upgrade to Basic for $7 your first month and I'll pick right back up: ${link}`;
      return repeat
        ? `Still paused: ${ABACUS_PLANS_URL}`
        : `I've paused because this month's credits are used up. Add credits to keep going: ${ABACUS_PLANS_URL}`;
    }
    case "own-key":
      if (account === "free")
        return repeat
          ? `Still paused: ${link}`
          : `${ownKeyLead(error)} Use any model on AbacusAI, $7 your first month: ${link}`;
      return repeat
        ? ownKeyLead(error)
        : `${ownKeyLead(error)} Use it in AbacusAI Agent on the web: ${ABACUS_AGENT_URL}`;
    case "free-pool-out":
      if (account === "paid") return GENERIC_REPLY;
      return repeat
        ? `Still paused: ${link}`
        : `The free models are busy right now. Upgrade to Basic for $7 your first month to use the top models: ${link}`;
    case "model-unavailable":
      return NO_MODEL_REPLY;
    case "generic":
      return GENERIC_REPLY;
  }
};

/**
 * What the user's own chat hears when a turn in someone else's chat failed:
 * who went unanswered, and the same line their own chat would have had.
 */
export const contactFailureNotice = (
  contactName: string | null,
  ownLine: string
): string => {
  const name =
    contactName != null && contactName.trim().length > 0
      ? contactName.trim()
      : "someone";
  return ownLine === GENERIC_REPLY
    ? `I couldn't reply to ${name} just now: something went wrong on my side.`
    : `I couldn't reply to ${name} just now. ${ownLine}`;
};

/** How long a chat waits before it hears the full offer again. */
export const FAILURE_REPLY_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Gateway-lifetime memory of what each chat was already told, so a run of
 * failures does not turn into a run of sales pitches.
 */
export class FailureReplyThrottle {
  private readonly offered = new Map<string, number>();
  private readonly noticed = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Whether this chat already had the full line for this kind inside the
   * window. Only offers are throttled; the sign-in and generic lines are
   * short already and go every time.
   */
  repeat(chatKey: string, kind: FailureKind): boolean {
    if (kind === "model-unavailable" || kind === "generic") return false;
    return !this.claim(this.offered, `${chatKey}:${kind}`);
  }

  /** Whether a contact-failure notice for this contact may go now. */
  mayNotice(contactKey: string): boolean {
    return this.claim(this.noticed, contactKey);
  }

  private claim(seen: Map<string, number>, key: string): boolean {
    const at = this.now();
    const last = seen.get(key);
    if (last != null && at - last < FAILURE_REPLY_WINDOW_MS) return false;
    seen.set(key, at);
    return true;
  }
}
