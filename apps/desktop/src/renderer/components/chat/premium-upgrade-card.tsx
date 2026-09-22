import { ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { NotificationAction } from "../../conversation/agent-types";
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
import { useCreditsStore } from "../../stores/credits-store";
import { Button } from "../ui";
import { ProviderMark } from "./provider-mark";

const CONNECT_LABEL: Record<FreeSource, string> = {
  openrouter: "workspace.modelPicker.connectOpenRouter",
  gemini: "workspace.modelPicker.connectGoogleAi",
};

/**
 * The card standing where a turn died for want of credits (a red line quoting
 * the provider's JSON there reads as a crash rather than a plan boundary).
 * The free tier is never sold a plan here: its way on is the free sources it
 * has not connected yet, then the model picker. A paid tier tops up.
 */
export const PremiumUpgradeCard = ({
  dataId,
  freeModels = [],
  onPickModel,
  onSwitchModel,
  onResume,
}: {
  dataId: string;
  /** Models the platform still serves for free; each one is a way to keep going. */
  freeModels?: FreeModelSwitch[];
  onPickModel?: (modelId: string) => void;
  /** Point the user at the model picker — the other models they already hold. */
  onSwitchModel?: () => void;
  /** Run the dead turn again on the free pool, once a source has joined it. */
  onResume?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const markExhausted = useCreditsStore((state) => state.markExhausted);
  const { data: account } = useAbacusAccountQuery();
  const { data: providers } = useModelProvidersQuery();
  const { connect, connecting } = useConnectFreeProvider();

  // A card standing where a turn died is the freshest word that the credits
  // are gone; the sidebar keeps showing the way out after this chat is gone.
  useEffect(() => {
    markExhausted();
  }, [markExhausted]);

  const tier = creditsTier(account);
  const paying = tier === "paid" || tier === "basic";
  const missing = paying ? [] : missingFreeSources(providers?.configured);

  const title = paying
    ? t("creditsCard.paidTitle")
    : t("workspace.premiumUpgrade.exhaustedTitle");
  const note = paying
    ? t("creditsCard.paidBody")
    : missing.length > 0
      ? t("workspace.premiumUpgrade.connectNote")
      : t("workspace.premiumUpgrade.switchNote");

  return (
    <div
      data-id={dataId}
      className="border-primary/35 from-primary/15 flex flex-wrap items-center gap-3 rounded-lg border bg-gradient-to-br to-violet-700/10 px-3.5 py-3"
    >
      <span className="from-primary shadow-primary/40 flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b to-violet-700 shadow-[0_2px_8px]">
        <Sparkles className="text-primary-foreground size-4" />
      </span>
      <span className="flex min-w-0 flex-1 basis-40 flex-col">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-muted-foreground text-xs">{note}</span>
      </span>
      {onPickModel != null &&
        freeModels.map((choice) => (
          <Button
            key={choice.model}
            variant="secondary"
            size="sm"
            data-id={`${dataId}-free-model`}
            className="shrink-0"
            onClick={() => onPickModel(choice.model)}
          >
            {t("workspace.premiumUpgrade.continueOn", { model: choice.label })}
          </Button>
        ))}
      {paying ? (
        <Button
          size="sm"
          data-id={`${dataId}-cta`}
          className="from-primary shrink-0 bg-gradient-to-b to-violet-700 font-semibold"
          onClick={() => {
            void window.api.openExternal(
              tier === "paid" ? ABACUS_BUY_CREDITS_URL : ABACUS_PLAN_URL
            );
          }}
        >
          {t("creditsCard.topUpCta")}
          <ArrowUpRight />
        </Button>
      ) : missing.length > 0 ? (
        missing.map((source) => (
          <Button
            key={source}
            size="sm"
            data-id={`${dataId}-connect-${source}`}
            className="from-primary shrink-0 bg-gradient-to-b to-violet-700 font-semibold"
            disabled={connecting != null}
            onClick={() => {
              void connect(source).then((connected) => {
                if (connected) onResume?.();
              });
            }}
          >
            <ProviderMark provider={source} className="size-3.5" />
            {t(CONNECT_LABEL[source])}
          </Button>
        ))
      ) : (
        onSwitchModel != null && (
          <Button
            size="sm"
            variant="secondary"
            data-id={`${dataId}-switch`}
            className="shrink-0"
            onClick={onSwitchModel}
          >
            {t("workspace.switchModel")}
          </Button>
        )
      )}
    </div>
  );
};

/** A `switch-model` action naming its target: what the card can offer. */
export interface FreeModelSwitch {
  model: string;
  label: string;
}

/** The named switches among an error's actions — the free models to offer. */
export const freeModelSwitches = (
  actions?: NotificationAction[]
): FreeModelSwitch[] =>
  (actions ?? []).flatMap((action) =>
    action.type === "switch-model" && action.model != null
      ? [{ model: action.model, label: action.label ?? action.model }]
      : []
  );

/** Whether an error's actions ask for the upgrade card instead of a red line. */
export const wantsUpgradeCard = (actions?: NotificationAction[]): boolean =>
  actions?.some((action) => action.type === "upgrade-abacus") === true;
