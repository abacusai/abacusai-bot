import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { AbacusAccountInfo } from "#shared/contracts";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useModelProvidersQuery } from "../../hooks/use-model-providers";
import { durableStorage } from "../../lib/durable-storage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import {
  isExhaustedMarkLive,
  useCreditsStore,
} from "../../stores/credits-store";
import { ABACUS_PLAN_URL } from "../chat/premium-upgrade-card";
import { UpsellCard } from "./upsell-card";

/** Where a Pro account tops up, rather than the plan chooser it has used. */
export const ABACUS_BUY_CREDITS_URL =
  "https://apps.abacus.ai/chatllm/admin/profile?buyCredits=true";

/** Free-pool sources: a key here is already spent when the pool is exhausted. */
const FREE_POOL_PROVIDERS = new Set(["abacus", "gemini", "openrouter"]);

/** The plan a card should speak to. Unknown until the account is read. */
export type CreditsTier = "free" | "basic" | "paid" | "unknown";

export const creditsTier = (
  account: AbacusAccountInfo | null | undefined
): CreditsTier => {
  const tier = account?.subscription_tier?.trim().toLowerCase();

  if (tier == null || tier.length === 0) return "unknown";
  if (tier === "free") return "free";
  if (tier === "basic") return "basic";

  return "paid";
};

/** A paid tier: the card would be selling them what they already have. */
const isPaidTier = (account: AbacusAccountInfo | null | undefined): boolean =>
  creditsTier(account) === "paid";

/** The account endpoint's own word that the included credits are spent. */
const accountSaysExhausted = (
  account: AbacusAccountInfo | null | undefined
): boolean =>
  account?.credits_granted != null &&
  account.credits_granted > 0 &&
  account.credits_used != null &&
  account.credits_used >= account.credits_granted;

/**
 * Whether the sidebar shows the out-of-credits card: a turn that died for
 * want of credits or the account's counters; a paid tier overrules both.
 */
export const shouldShowCreditsCard = ({
  account,
  exhaustedAt,
  now = Date.now(),
}: {
  account: AbacusAccountInfo | null | undefined;
  exhaustedAt: number | null;
  now?: number;
}): boolean =>
  // An unread account is not a free one. Reading it as free told a Pro user
  // who had run out that they had used up their *free* credits and should
  // upgrade to the plan they were already paying for.
  creditsTier(account) !== "unknown" &&
  (isExhaustedMarkLive(exhaustedAt, now) || accountSaysExhausted(account));

/**
 * Which card the free tier sees. The upsell stands until they close it; the
 * out-of-credits state outranks that, because by then it is not a pitch but
 * the reason the app stopped answering.
 */
export const creditsCardState = ({
  account,
  exhaustedAt,
  dismissed,
  now = Date.now(),
}: {
  account: AbacusAccountInfo | null | undefined;
  exhaustedAt: number | null;
  dismissed: boolean;
  now?: number;
}): "exhausted" | "upsell" | null => {
  // A basic plan is a paying one: the sidebar offers it the Abacus AI agent
  // and nothing else. Selling an upgrade beside that reads as a nag to
  // someone who already bought.
  if (creditsTier(account) === "basic") return null;
  if (shouldShowCreditsCard({ account, exhaustedAt, now })) return "exhausted";
  // No account read yet is not a free tier; the card would flash and go.
  if (account == null || isPaidTier(account)) return null;
  return dismissed ? null : "upsell";
};

/**
 * Providers the user could switch to right now, outside the pool that just ran
 * dry. A key here means the answer is "change model", not "pay us": selling an
 * upgrade to someone who already has a working OpenAI key is the wrong advice.
 */
export const alternativeProviderLabels = (
  configured: Record<string, boolean> | undefined
): string[] =>
  PROVIDER_KEY_FIELDS.filter(
    (field) =>
      field.kind === "model" &&
      !FREE_POOL_PROVIDERS.has(field.provider) &&
      configured?.[field.provider] === true
  ).map((field) => field.label);

/** "OpenAI", "OpenAI or Anthropic", "OpenAI, Anthropic or Groq". */
export const joinProviderLabels = (labels: string[], or: string): string =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} ${or} ${labels[labels.length - 1]}`;

const DISMISSED_KEY = "local-code:upsell-dismissed";

const readDismissed = (): boolean => {
  try {
    return durableStorage.getItem(DISMISSED_KEY) != null;
  } catch {
    return false;
  }
};

/** The free tier's card, pinned above the account row so the way out stays. */

export const CreditsExhaustedCard = (): JSX.Element | null => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: account, dataUpdatedAt } = useAbacusAccountQuery();
  const { data: providers } = useModelProvidersQuery();
  const exhaustedAt = useCreditsStore((state) => state.exhaustedAt);
  const [dismissed, setDismissed] = useState(readDismissed);
  const clearExhausted = useCreditsStore((state) => state.clearExhausted);

  // The account refreshed after the mark and shows headroom again.
  useEffect(() => {
    if (exhaustedAt == null || dataUpdatedAt <= exhaustedAt) return;
    const headroom =
      account?.credits_granted != null &&
      account.credits_used != null &&
      account.credits_used < account.credits_granted;
    if (isPaidTier(account) || headroom) clearExhausted();
  }, [account, clearExhausted, dataUpdatedAt, exhaustedAt]);

  // A fresh mark deserves fresh counters: ask past the main process's cache.
  useEffect(() => {
    if (exhaustedAt == null) return;
    void window.api.agent.getAbacusAccount(true).then((fresh) => {
      if (fresh != null)
        queryClient.setQueryData(workspaceQueryKeys.abacusAccount, fresh);
    });
  }, [exhaustedAt, queryClient]);

  const navigate = useNavigate();
  const state = creditsCardState({ account, exhaustedAt, dismissed });
  if (state == null) return null;
  const exhausted = state === "exhausted";
  const tier = creditsTier(account);
  // Out of Abacus credits with another provider's key on disk: the way back is
  // the model picker, not the billing page.
  const alternatives = exhausted
    ? alternativeProviderLabels(providers?.configured)
    : [];
  const canSwitch = alternatives.length > 0;
  const paid = tier === "paid";

  const title = !exhausted
    ? t("creditsCard.upsellTitle")
    : canSwitch
      ? t("creditsCard.switchTitle")
      : t(paid ? "creditsCard.paidTitle" : "creditsCard.title");
  const body = !exhausted
    ? t("creditsCard.upsellBody")
    : canSwitch
      ? t("creditsCard.switchBody", {
          providers: joinProviderLabels(alternatives, t("creditsCard.or")),
        })
      : t(paid ? "creditsCard.paidBody" : "creditsCard.body");

  return (
    <UpsellCard
      dataId="sidebar-credits-card"
      title={title}
      body={body}
      // The switch card is the whole message: its action is a picker in the
      // composer, and a button here would lead somewhere else entirely.
      {...(canSwitch
        ? {}
        : {
            cta: t(paid ? "creditsCard.topUpCta" : "creditsCard.cta"),
            onCta: () => {
              void window.api.openExternal(
                paid ? ABACUS_BUY_CREDITS_URL : ABACUS_PLAN_URL
              );
            },
          })}
      // Out of credits on a free plan: the other way to more is to invite friends.
      {...(exhausted && !paid && !canSwitch
        ? {
            secondaryCta: t("creditsCard.inviteCta"),
            onSecondaryCta: () => {
              void navigate({ to: "/settings/referrals" });
            },
          }
        : {})}
      // No way out of the out-of-credits state but the button: closing it
      // would hide the only explanation for a turn that will not run.
      {...(exhausted
        ? {}
        : {
            dismissLabel: t("creditsCard.dismiss"),
            onDismiss: () => {
              try {
                durableStorage.setItem(DISMISSED_KEY, "1");
              } catch {
                // A card that cannot remember being closed still closes.
              }
              setDismissed(true);
            },
          })}
    />
  );
};
