import {
  type BillingPlan,
  paidCreditsOffer,
  paidUpgradeOnly,
  planPitch,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import {
  creditThresholdWords,
  type CreditThresholdMark,
  tasksLeft,
} from "@abacus-ai/contract/credit-thresholds";
import { providerDisplayName } from "@abacus-ai/contract/settings";
import { SUCCESS_PITCH_MOMENT_COPY } from "@abacus-ai/contract/success-pitch";

import type { TurnRecord } from "../session/turn-ledger";
import type { ChannelWords } from "./channel-words";

/**
 * What a chat is told when a turn failed, on every platform and lane. Never
 * the raw error: provider JSON and credit-wall text reached phones, and other
 * people's chats, as the bot's reply. The pane and the log keep the real text.
 * Every line is the app's own translation (channel-words.ts) and every price,
 * credit and feature comes from the account's billing plan.
 */

/** The user's own chat on the platform, or someone they auto-reply to. */
export type ChatKind = "own" | "other";

/** The signed-in Abacus plan as last read; unknown when never read. */
export type AccountKind = "free" | "paid" | "unknown";

/** What the gateway reads off a failed turn's error event. */
export interface TurnFailure {
  code?: string;
  cause?: string;
  actions?: ReadonlyArray<{
    type: string;
    provider?: string;
    cause?: string;
    model?: string;
    label?: string;
    link?: string;
    credits?: string;
  }>;
}

/**
 * A failure as the chat hears it. The first three are the ones whose line
 * sells a way out, which the throttle holds to once per window.
 */
export type FailureKind =
  | "cut-off"
  | "model-gone"
  | "upgrade-abacus"
  | "own-key"
  | "key-rejected"
  | "payment"
  | "verify-phone"
  | "free-pool-out"
  | "model-unavailable"
  | "connection"
  | "timed-out"
  | "agent-exited"
  | "empty"
  | "generic";

/** Where the chat's upgrade and top-up lines point, and what they offer. */
export interface ChannelOffer {
  /** The account's own upgrade link, or the bot's upgrade page. */
  upgradeUrl: string;
  /** Where a paid account adds credits; the upgrade link when unknown. */
  topUpUrl: string;
  /** The billing plan as just read; null when it could not be. */
  billing: BillingPlan | null;
  /** The free credits wait on a phone check: where to verify it. */
  verifyUrl?: string;
}

/** AbacusAI Agent on the web. */
const ABACUS_AGENT_URL = "https://apps.abacus.ai/chatllm";

/** Where a paid account buys credits when the billing plan could not be read. */
export const ABACUS_BUY_CREDITS_URL =
  "https://apps.abacus.ai/chatllm/admin/profile?buyCredits=true";

/** The account's billing page, where a payment is checked or a plan renewed. */
const ABACUS_BILLING_URL = "https://apps.abacus.ai/chatllm/admin/profile";

const NETWORK_UNREACHABLE_CODE = "network_unreachable";

/** The empty-reply failure's cause (the agent's turn-outcome.ts): one, whoever saw it. */
const EMPTY_CAUSE = "empty";

/**
 * What the chat is told about a closed turn (TurnLedger), or null when the
 * turn answered. `delivered`: something already reached the chat (the reply,
 * the agent's own send, NO_REPLY), so a turn that merely ended on nothing
 * more to say needs no line. A reply that never reached the chat is told as
 * an empty one: the chat must not be left on silence.
 */
export const chatFailureOf = (
  record: Pick<TurnRecord, "kind" | "cause" | "error">,
  delivered: boolean
): TurnFailure | null => {
  switch (record.kind) {
    case "reply":
      return delivered ? null : { cause: EMPTY_CAUSE };
    case "failed": {
      const error = record.error;
      const cause = error?.cause ?? record.cause;
      if (cause === EMPTY_CAUSE && delivered) return null;
      return {
        ...(error?.code != null ? { code: error.code } : {}),
        ...(cause != null ? { cause } : {}),
        ...(error?.actions != null || error?.segmentData?.actions != null
          ? { actions: error.actions ?? error.segmentData?.actions }
          : {}),
      };
    }
    case "timed_out":
    case "agent_exited":
      return { code: record.kind };
    case "stopped":
      return null;
  }
};

/** Whose own key failed: the own-key offer, or the key to fix. */
const ownKeyAction = (error: TurnFailure) =>
  error.actions?.find((action) => action.type === "own-key-unavailable") ??
  error.actions?.find((action) => action.type === "fix-key");

export const failureKind = (error: TurnFailure): FailureKind => {
  const types = new Set(error.actions?.map((action) => action.type));
  // Google cut the reply off: its own line, whatever the credits.
  if (types.has("cut-off")) return "cut-off";
  // The picked model cannot serve the turn: its own line, credits or not.
  if (types.has("model-unavailable")) return "model-gone";
  if (types.has("upgrade-abacus")) return "upgrade-abacus";
  // Free credits held for a phone check: the verify page, never a plan.
  if (types.has("verify-phone")) return "verify-phone";
  // Abacus's billing gate: never the out-of-credits line, nor a purchase.
  if (types.has("payment-required")) return "payment";
  if (error.cause === "key_invalid" && types.has("fix-key"))
    return "key-rejected";
  if (ownKeyAction(error)?.provider != null) return "own-key";
  // Before the sign-in line: a shut free pool reports model_unavailable too.
  if (types.has("free-pool-out")) return "free-pool-out";
  if (error.code === "model_unavailable") return "model-unavailable";
  if (error.code === NETWORK_UNREACHABLE_CODE) return "connection";
  // Endings main decides: the inactivity watchdog, the agent going away.
  if (error.code === "timed_out") return "timed-out";
  if (error.code === "agent_exited") return "agent-exited";
  if (error.cause === EMPTY_CAUSE) return "empty";
  return "generic";
};

/** Whether the line for this failure could carry the account's upgrade link. */
export const wantsUpgradeUrl = (
  error: TurnFailure,
  account: AccountKind
): boolean => {
  const kind = failureKind(error);
  if (kind === "upgrade-abacus" || kind === "model-gone")
    return account === "free";
  if (kind === "cut-off")
    return account === "free" && cutOffCause(error) === "out";
  return kind === "free-pool-out" && account !== "paid";
};

/**
 * The plan on offer, its price and its whole pitch, then the link: all from
 * billing_plan (planPitch), the same lines the app's dialog lists.
 */
const offerLines = (words: ChannelWords, offer: ChannelOffer): string[] => {
  const { t, locale } = words;
  const plan = wallOffer(offer.billing);
  return [
    ...(plan != null
      ? [
          t("outcome.channel.offer", {
            plan: plan.planName,
            price: planPrice(t, plan, locale),
          }),
          ...planPitch(t, offer.billing, locale).map((line) => `- ${line}`),
        ]
      : []),
    t("outcome.channel.link", { link: plan?.url ?? offer.upgradeUrl }),
  ];
};

/**
 * A paid plan out of credits, by the one offer rule (paidCreditsOffer):
 * `topUp` (the line that sends the user to buy credits), then the next plan
 * up with its price and link when the server offers one. Basic's way on is
 * the next plan alone, so its reply is that plan's line (`upgradeOnlyKey`)
 * and no top-up. A plan billed by Apple or Google is bought in the mobile
 * app, so the line says so in place of both links.
 */
const paidOutLines = (
  words: ChannelWords,
  offer: ChannelOffer,
  topUp: string,
  upgradeOnlyKey: string
): string => {
  const { t, locale } = words;
  const paid = paidCreditsOffer(offer.billing);
  if (paid?.inMobileApp === true) return t("outcome.channel.paidMobile");
  const next = paid?.next;
  if (next?.url == null) return topUp;
  const values = {
    plan: next.planName,
    price: planPrice(t, next, locale),
    link: next.url,
  };
  return paidUpgradeOnly(paid)
    ? t(upgradeOnlyKey, values)
    : `${topUp}\n${t("outcome.channel.paidUpgrade", values)}`;
};

/** Where the Abacus credits stood when Google cut the reply off. */
const cutOffCause = (error: TurnFailure): string | undefined =>
  error.actions?.find((action) => action.type === "cut-off")?.cause;

const ownKeyLead = (words: ChannelWords, error: TurnFailure): string => {
  const action = ownKeyAction(error);
  const provider = providerDisplayName(action?.provider ?? "");
  if (action?.cause === "credit" || error.cause === "own_key_quota")
    return words.t("outcome.channel.ownKeyCredit", { provider });
  if (action?.cause === "rate_limit")
    return words.t("outcome.channel.ownKeyRateLimit", { provider });
  return words.t("outcome.channel.ownKeyDown", { provider });
};

/**
 * The single place a failed turn becomes chat words. Someone else's chat gets
 * none of these: no error, no offer, only the gateway's neutral line. With
 * `repeat`, the offer already went to this chat inside the throttle window, so
 * the line shrinks to a reminder.
 */
export const chatReplyForFailure = (
  error: TurnFailure,
  chatKind: ChatKind,
  account: AccountKind,
  words: ChannelWords,
  offer: ChannelOffer,
  repeat = false
): string | null => {
  if (chatKind === "other") return null;
  const { t } = words;
  const reminder = t("outcome.channel.repeat", { link: offer.upgradeUrl });
  switch (failureKind(error)) {
    case "cut-off": {
      // The way on is the app's: RouteLLM - Open while Abacus credits are
      // left (a phone check first while they are held), the plan once they
      // are used up. Chat apps have no switch, so the line says where it is.
      const lead = t("outcome.channel.cutoff");
      const cause = cutOffCause(error);
      if (offer.verifyUrl != null)
        return `${lead} ${t("outcome.channel.cutoffVerify", { link: offer.verifyUrl })}`;
      if (cause === "credits")
        return `${lead} ${t("outcome.channel.cutoffSwitch")}`;
      if (cause !== "out") return lead;
      if (account !== "free")
        return `${lead} ${paidOutLines(words, offer, t("outcome.channel.cutoffTopUp", { link: offer.topUpUrl }), "outcome.channel.paidUpgrade")}`;
      return repeat ? lead : [lead, ...offerLines(words, offer)].join("\n");
    }
    case "model-gone": {
      // The picked model cannot serve the turn. With credits left the way on
      // is RouteLLM - Open, picked in the app (chat apps have no switch);
      // with them used up, the plan.
      const gone = error.actions?.find(
        (action) => action.type === "model-unavailable"
      );
      const model = gone?.label ?? gone?.model ?? "";
      const creditsOut =
        error.actions?.some((action) => action.type === "upgrade-abacus") ===
        true;
      if (creditsOut)
        return repeat
          ? reminder
          : account === "free"
            ? [
                t("outcome.channel.unavailableOut", { model }),
                ...offerLines(words, offer),
              ].join("\n")
            : `${t("outcome.channel.unavailableOut", { model })} ${paidOutLines(words, offer, t("outcome.channel.paidOut", { link: offer.topUpUrl }), "outcome.channel.paidUpgradeOnly")}`;
      if (gone?.cause !== "plan")
        return t(
          gone?.cause === "down"
            ? "outcome.channel.unavailableDown"
            : "outcome.channel.unavailable",
          { model }
        );
      // Said again inside the throttle window: the line without the offer.
      if (repeat) return t("outcome.channel.unavailablePlan", { model });
      return account === "free"
        ? [
            t("outcome.channel.unavailablePlan", { model }),
            ...offerLines(words, offer),
          ].join("\n")
        : `${t("outcome.channel.unavailablePlan", { model })} ${t("outcome.channel.link", { link: offer.upgradeUrl })}`;
    }
    case "upgrade-abacus": {
      // Why the credit gate refused, when the agent could tell.
      const expired =
        error.actions?.find((action) => action.type === "upgrade-abacus")
          ?.cause === "expired";
      // An account never read is worded like a paid one: no plan to sell.
      if (account !== "free") {
        const paid = paidCreditsOffer(offer.billing);
        return repeat
          ? paid?.inMobileApp === true
            ? t("outcome.channel.paidMobile")
            : t("outcome.channel.repeat", {
                // Basic's reminder links its next plan, never a top-up.
                link: paidUpgradeOnly(paid) ? paid.next.url : offer.topUpUrl,
              })
          : paidOutLines(
              words,
              offer,
              t("outcome.channel.paidOut", { link: offer.topUpUrl }),
              "outcome.channel.paidOutUpgrade"
            );
      }
      if (repeat) return reminder;
      return [
        t(expired ? "outcome.channel.expired" : "outcome.channel.wall"),
        ...offerLines(words, offer),
      ].join("\n");
    }
    case "own-key":
      // Free: the Abacus credits still run (a spent account is the wall's
      // line), so the way on is switching to them, not half a pitch.
      if (account === "free")
        return repeat
          ? ownKeyLead(words, error)
          : `${ownKeyLead(words, error)} ${t("outcome.channel.ownKeySwitch")}`;
      return repeat
        ? ownKeyLead(words, error)
        : `${ownKeyLead(words, error)} ${t("outcome.channel.ownKeyWeb", { link: ABACUS_AGENT_URL })}`;
    case "payment":
      return t(
        error.actions?.find((action) => action.type === "payment-required")
          ?.cause === "lapsed"
          ? "outcome.channel.paymentLapsed"
          : "outcome.channel.payment",
        { link: ABACUS_BILLING_URL }
      );
    case "verify-phone": {
      const verify = error.actions?.find(
        (action) => action.type === "verify-phone"
      );
      // The agent always names the page (the server's, else its default).
      const link = verify?.link;
      if (link == null) return t("outcome.channel.generic");
      return verify?.credits != null
        ? t("outcome.channel.verifyPhone", { credits: verify.credits, link })
        : t("outcome.channel.verifyPhoneNoCount", { link });
    }
    case "key-rejected":
      return t("outcome.channel.ownKeyRejected", {
        provider: providerDisplayName(ownKeyAction(error)?.provider ?? ""),
      });
    case "free-pool-out":
      if (account === "paid") return t("outcome.channel.generic");
      if (repeat) return reminder;
      return [t("outcome.channel.busy"), ...offerLines(words, offer)].join(
        "\n"
      );
    case "model-unavailable":
      return t("outcome.channel.notSignedIn");
    case "connection":
      return t("outcome.channel.connection");
    case "timed-out":
      return t("outcome.channel.timedOut");
    case "agent-exited":
      return t("outcome.channel.agentExited");
    case "empty":
      return t("outcome.channel.empty");
    case "generic":
      return t("outcome.channel.generic");
  }
};

/**
 * A free account crossed a credit milestone in a chat-app turn: the card's
 * words, as of the read that crossed it, then the upgrade link. No keyword to
 * reply with; the link is the way on.
 */
export const chatLineForCreditThreshold = (
  words: ChannelWords,
  mark: CreditThresholdMark,
  link: string,
  billing: BillingPlan | null = null
): string => {
  const left = Math.max(0, mark.granted - mark.used);
  const count = tasksLeft(left, mark.perTask);
  const { title, lines } = creditThresholdWords(
    words.t,
    words.locale,
    mark.reached,
    { left, total: mark.granted },
    count != null ? { count, kind: mark.kind } : null
  );
  // The plan's whole pitch, as every upgrade line carries it; the link last.
  return [
    title,
    ...lines,
    ...offerLines(words, { upgradeUrl: link, topUpUrl: link, billing }).slice(
      0,
      -1
    ),
    words.t("outcome.channel.link", { link }),
  ].join("\n");
};

/**
 * The success pitch in the user's own chat app, once ever after they praised
 * a result: glad it worked, the plan's whole pitch with its price, the link,
 * and that it will not be said there again.
 */
export const chatLineForSuccessPitch = (
  words: ChannelWords,
  link: string,
  billing: BillingPlan | null
): string =>
  [
    words.t(SUCCESS_PITCH_MOMENT_COPY.reaction),
    ...offerLines(words, { upgradeUrl: link, topUpUrl: link, billing }),
    words.t("successPitch.chat.once"),
  ].join("\n");

/**
 * What the user's own chat hears when a turn in someone else's chat failed:
 * who went unanswered, and the same line their own chat would have had.
 */
export const contactFailureNotice = (
  words: ChannelWords,
  contactName: string | null,
  ownLine: string,
  kind?: FailureKind
): string => {
  const name =
    contactName != null && contactName.trim().length > 0
      ? contactName.trim()
      : words.t("outcome.channel.someone");
  // Nothing went out to them, not even the neutral line: the user decides.
  if (kind === "empty")
    return words.t("outcome.channel.contactEmpty", { name });
  return ownLine === words.t("outcome.channel.generic")
    ? words.t("outcome.channel.contactFailedGeneric", { name })
    : `${words.t("outcome.channel.contactFailed", { name })} ${ownLine}`;
};

/** How long a chat waits before it hears the full offer again. */
export const FAILURE_REPLY_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Gateway-lifetime memory of what each chat was already told, so a run of
 * failures does not turn into a run of sales pitches.
 */
export class FailureReplyThrottle {
  private readonly offered = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Whether this chat already had the full line for this kind inside the
   * window. Only offers are throttled; the sign-in, connection and generic
   * lines are short already and go every time.
   */
  repeat(chatKey: string, kind: FailureKind): boolean {
    if (
      kind === "model-unavailable" ||
      kind === "generic" ||
      kind === "connection" ||
      kind === "key-rejected" ||
      kind === "verify-phone" ||
      kind === "timed-out" ||
      kind === "agent-exited" ||
      kind === "empty"
    )
      return false;
    return !this.claim(this.offered, `${chatKey}:${kind}`);
  }

  private claim(seen: Map<string, number>, key: string): boolean {
    const at = this.now();
    const last = seen.get(key);
    if (last != null && at - last < FAILURE_REPLY_WINDOW_MS) return false;
    seen.set(key, at);
    return true;
  }
}
