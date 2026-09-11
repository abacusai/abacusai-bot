import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { UpsellCard } from "./upsell-card";

const DEEPAGENT_URL = "https://apps.abacus.ai/chatllm";

/**
 * A sidebar card pointing paid Abacus accounts at the Abacus AI agent on the
 * web — the upsell for work this app is not the place for: long, complex,
 * agentic runs. The free tier does not get it, because that agent is what
 * their plan lacks, and a link that lands them on a paywall reads as a bait
 * card rather than a shortcut. Same shape as the card the free tier sees in
 * its place, so the sidebar's last row looks the same on every plan.
 */
export const DeepAgentCard = (): JSX.Element | null => {
  const { t } = useTranslation();
  const { data: abacusAccount } = useAbacusAccountQuery();
  const tier = abacusAccount?.subscription_tier;
  if (tier == null || tier === "free") return null;

  return (
    <UpsellCard
      dataId="sidebar-deepagent-card"
      title={t("deepAgentCard.title")}
      body={t("deepAgentCard.body")}
      cta={t("deepAgentCard.cta")}
      onCta={() => {
        void window.api.openExternal(DEEPAGENT_URL);
      }}
    />
  );
};
