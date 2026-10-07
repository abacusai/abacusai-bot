import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import { creditsCardState, creditsTier } from "#renderer/lib/credits";

export const PROMO_SNOOZE_MS = 10 * 60 * 1000;
export interface PromoSnooze {
  until: number;
  situation: "upsell" | "exhausted";
}
export const promoAccountKey = (
  account: AbacusAccountInfo | null | undefined
): string =>
  `abacusai-bot:promo:v2:${encodeURIComponent(account?.organization_id ?? "")}:${encodeURIComponent(account?.user_id ?? account?.email ?? "anonymous")}`;
export const promoState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  snooze: PromoSnooze | null,
  now: number
): "upsell" | "exhausted" | null => {
  if (creditsTier(account) !== "free") return null;
  const state = creditsCardState(account, mark, false, now);
  if (!state) return null;
  return snooze &&
    snooze.until > now &&
    (snooze.situation === "exhausted" || state === "upsell")
    ? null
    : state;
};
export const readPromoSnooze = (key: string): PromoSnooze | null => {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) ?? "null"
    ) as PromoSnooze | null;
    return value &&
      typeof value.until === "number" &&
      ["upsell", "exhausted"].includes(value.situation)
      ? value
      : null;
  } catch {
    return null;
  }
};
