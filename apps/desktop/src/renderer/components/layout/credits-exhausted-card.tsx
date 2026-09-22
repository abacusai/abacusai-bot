import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { AbacusAccountInfo } from "#shared/contracts";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import {
  missingFreeSources,
  useConnectFreeProvider,
  type FreeSource,
} from "../../hooks/use-connect-free-provider";
import { useModelProvidersQuery } from "../../hooks/use-model-providers";
import {
  ABACUS_BUY_CREDITS_URL,
  ABACUS_PLAN_URL,
  creditsTier,
} from "../../lib/abacus-credits";
import { durableStorage } from "../../lib/durable-storage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import {
  isExhaustedMarkLive,
  useCreditsStore,
} from "../../stores/credits-store";
import { ProviderMark } from "../chat/provider-mark";
import { UpsellCard } from "./upsell-card";

export {
  ABACUS_BUY_CREDITS_URL,
  creditsTier,
  type CreditsTier,
} from "../../lib/abacus-credits";

/** Free-pool sources: a key here is already spent when the pool is exhausted. */
const FREE_POOL_PROVIDERS = new Set(["abacus", "gemini", "openrouter"]);

const CONNECT_LABEL: Record<FreeSource, string> = {
  openrouter: "workspace.modelPicker.connectOpenRouter",
  gemini: "workspace.modelPicker.connectGoogleAi",
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
  const { connect, connecting } = useConnectFreeProvider();

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

  const state = creditsCardState({ account, exhaustedAt, dismissed });
  if (state == null) return null;
  const exhausted = state === "exhausted";
  const tier = creditsTier(account);
  const paid = tier === "paid";
  // Out of Abacus credits with another provider's key on disk: the way back is
  // the model picker, not the billing page.
  const alternatives = exhausted
    ? alternativeProviderLabels(providers?.configured)
    : [];
  const canSwitch = alternatives.length > 0;
  // The free tier is never sold a plan from here: its way on is the free
  // sources it has not connected yet, then the picker.
  const missing =
    exhausted && !paid && !canSwitch
      ? missingFreeSources(providers?.configured)
      : [];
  const canConnect = missing.length > 0;

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
      : paid
        ? t("creditsCard.paidBody")
        : canConnect
          ? t("creditsCard.connectBody")
          : t("creditsCard.pickBody");

  return (
    <UpsellCard
      dataId="sidebar-credits-card"
      title={title}
      body={body}
      // The switch and pick cards are the whole message: their action is a
      // picker in the composer, and a button here would lead somewhere else.
      {...(exhausted && !paid
        ? canConnect
          ? {
              actions: missing.map((source) => ({
                id: source,
                label: t(CONNECT_LABEL[source]),
                icon: <ProviderMark provider={source} className="size-3.5" />,
                disabled: connecting != null,
                onClick: () => void connect(source),
              })),
            }
          : {}
        : {
            cta: t(paid ? "creditsCard.topUpCta" : "creditsCard.cta"),
            onCta: () => {
              void window.api.openExternal(
                paid ? ABACUS_BUY_CREDITS_URL : ABACUS_PLAN_URL
              );
            },
          })}
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
