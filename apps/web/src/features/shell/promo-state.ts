import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import { creditsCardState, creditsTier } from "#renderer/lib/credits";

export const PROMO_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
export interface PromoDismissal {
  until: number;
  situation: "upsell" | "exhausted";
}
export const promoAccountKey = (
  account: AbacusAccountInfo | null | undefined
): string =>
  `abacusai-bot:promo:v1:${encodeURIComponent(account?.organization_id ?? "")}:${encodeURIComponent(account?.user_id ?? account?.email ?? "anonymous")}`;
export const promoState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  dismissal: PromoDismissal | null,
  now: number
): "upsell" | "exhausted" | null => {
  if (creditsTier(account) !== "free") return null;
  const state = creditsCardState(account, mark, false, now);
  if (!state) return null;
  return dismissal && dismissal.until > now && dismissal.situation === state
    ? null
    : state;
};
export const readPromoDismissal = (key: string): PromoDismissal | null => {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) ?? "null"
    ) as PromoDismissal | null;
    return value &&
      typeof value.until === "number" &&
      ["upsell", "exhausted"].includes(value.situation)
      ? value
      : null;
  } catch {
    return null;
  }
};
