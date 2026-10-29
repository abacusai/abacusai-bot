import {
  phoneLanguage,
  phoneReplyLanguage,
} from "@abacus-ai/agent/phone-nudges";
import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";

import {
  channelLocale,
  channelWords,
} from "#main/services/messaging/channel-words";
import { chatLineForCreditThreshold } from "#main/services/messaging/chat-failure-reply";
import {
  botUpgradePage,
  fetchBillingPlan,
  WHATSAPP_UPGRADE_SRC,
} from "#main/services/providers/abacus-upgrade";

/** How long the line waits for the plan and the link before it goes with the bot's own page. */
const LINK_WAIT_MS = 5_000;

const within = <T>(call: Promise<T | null>): Promise<T | null> =>
  Promise.race([
    call.catch(() => null),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LINK_WAIT_MS).unref()
    ),
  ]);

export interface PhoneCreditLineDeps {
  /** The phone loop's directory: the language the user hears check-ins in. */
  phoneDir: string;
  /** One more text to the user on WhatsApp; whether it went. */
  say: (text: string) => Promise<boolean>;
  billing?: () => Promise<BillingPlan | null>;
}

/**
 * A free account crossed half, then four fifths, of its free credits in a
 * WhatsApp turn: the desktop's milestone line (the same words, once each),
 * in the user's language, with the plan's whole pitch, that everything then
 * works on their phone in the ChatLLM app, and the upgrade link.
 */
export const phoneCreditLine =
  (deps: PhoneCreditLineDeps) =>
  async (mark: CreditThresholdMark): Promise<boolean> => {
    const billing = await within(
      (
        deps.billing ??
        (() => fetchBillingPlan(false, undefined, WHATSAPP_UPGRADE_SRC))
      )()
    );
    const words = await channelWords(
      channelLocale(
        null,
        phoneReplyLanguage(deps.phoneDir) ?? phoneLanguage(deps.phoneDir)
      )
    );
    // AbacusAI Bot's page, tagged for WhatsApp: through the upgrade, then the ChatLLM app.
    const link = billing?.upgrades[0]?.url ?? botUpgradePage("whatsapp");
    return deps.say(
      chatLineForCreditThreshold(words, mark, link, billing, true)
    );
  };
