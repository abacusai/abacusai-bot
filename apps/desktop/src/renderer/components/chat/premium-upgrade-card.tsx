import { ArrowUpRight } from "lucide-react";
import { useEffect, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { NotificationAction } from "../../conversation/agent-types";
import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import {
  missingFreeSources,
  useConnectFreeProvider,
  type FreeSource,
} from "../../hooks/use-connect-free-provider";
import { useLocalModels } from "../../hooks/use-local-models";
import { useModelProvidersQuery } from "../../hooks/use-model-providers";
import {
  ABACUS_BUY_CREDITS_URL,
  ABACUS_PLAN_URL,
  creditsTier,
} from "../../lib/abacus-credits";
import { useCreditsStore } from "../../stores/credits-store";
import { useLocalModelDialogStore } from "../../stores/local-model-dialog-store";
import { Button } from "../ui";
import { ProviderMark } from "./provider-mark";

const SOURCE_NAME: Record<FreeSource, string> = {
  openrouter: "workspace.premiumUpgrade.sourceOpenrouter",
  gemini: "workspace.premiumUpgrade.sourceGemini",
};
const SOURCE_META: Record<FreeSource, string> = {
  openrouter: "workspace.premiumUpgrade.sourceOpenrouterMeta",
  gemini: "workspace.premiumUpgrade.sourceGeminiMeta",
};

/**
 * The card standing where a turn died for want of credits (a red line quoting
 * the provider's JSON there reads as a crash rather than a plan boundary).
 * The free tier is never sold a plan here: its way on is the free sources it
 * has not connected yet, then the model picker. A paid tier tops up.
 */
export const PremiumUpgradeCard = ({
  dataId,
  scope = "abacus",
  freeModels = [],
  onPickModel,
  onSwitchModel,
  onResume,
}: {
  dataId: string;
  /** See exhaustedScope: what ran out, which the title names. */
  scope?: "abacus" | "pool";
  /** Models the platform still serves for free; each one is a way to keep going. */
  freeModels?: FreeModelSwitch[];
  onPickModel?: (modelId: string) => void;
  /** Point the user at the model picker: the other models they already hold. */
  onSwitchModel?: () => void;
  /** Run the dead turn again on the free pool, once a source has joined it. */
  onResume?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const markExhausted = useCreditsStore((state) => state.markExhausted);
  const { data: account } = useAbacusAccountQuery();
  const { data: providers } = useModelProvidersQuery();
  const { connect, connecting, keyDialog } = useConnectFreeProvider();
  const { state: localModels } = useLocalModels();
  const showLocalModelDialog = useLocalModelDialogStore((store) => store.show);

  // A card standing where a turn died is the freshest word that the credits
  // are gone; the sidebar keeps showing the way out after this chat is gone.
  useEffect(() => {
    markExhausted();
  }, [markExhausted]);

  const tier = creditsTier(account);
  const paying = tier === "paid" || tier === "basic";
  const missing = paying ? [] : missingFreeSources(providers?.configured);
  // Every free source connected and spent: the model that cannot run out.
  const canGoLocal =
    !paying && missing.length === 0 && localModels?.runtimeAvailable === true;

  const title = paying
    ? t("creditsCard.paidTitle")
    : scope === "pool"
      ? t("workspace.premiumUpgrade.poolOutTitle")
      : t("workspace.premiumUpgrade.exhaustedTitle");
  const note = paying
    ? t("creditsCard.paidBody")
    : missing.length > 0
      ? t("workspace.premiumUpgrade.connectNote")
      : canGoLocal
        ? t("workspace.premiumUpgrade.localNote")
        : t("workspace.premiumUpgrade.switchNote");

  // A header and one row per way forward, each with its own button: the
  // decision is "which source?", and a list of them reads as a choice where
  // buttons inline with the text read as an error with too many exits.
  const rows: SourceRow[] = paying
    ? [
        {
          key: "cta",
          mark: "abacus",
          name: t("creditsCard.topUpCta"),
          meta: t("workspace.premiumUpgrade.topUpMeta"),
          cta: t("creditsCard.topUpCta"),
          onClick: () => {
            void window.api.openExternal(
              tier === "paid" ? ABACUS_BUY_CREDITS_URL : ABACUS_PLAN_URL
            );
          },
        },
      ]
    : [
        ...(onPickModel != null
          ? freeModels.map((choice) => ({
              key: "free-model",
              mark: "abacus",
              name: choice.label,
              meta: t("workspace.premiumUpgrade.continueOn", {
                model: choice.label,
              }),
              cta: t("workspace.premiumUpgrade.continueCta"),
              onClick: () => onPickModel(choice.model),
            }))
          : []),
        ...missing.map((source) => ({
          key: `connect-${source}`,
          mark: source,
          name: t(SOURCE_NAME[source]),
          meta: t(SOURCE_META[source]),
          cta: t("workspace.premiumUpgrade.connectCta"),
          disabled: connecting != null,
          onClick: () => {
            void connect(source).then((connected) => {
              if (connected) onResume?.();
            });
          },
        })),
        ...(canGoLocal
          ? [
              {
                key: "local",
                mark: "local",
                name: t("workspace.premiumUpgrade.localName"),
                meta: t("workspace.premiumUpgrade.localMeta"),
                cta: t("workspace.premiumUpgrade.setUpCta"),
                quiet: true,
                // Once the model is ready the dead turn runs again on it.
                onClick: () =>
                  showLocalModelDialog((model) => {
                    onPickModel?.(model);
                    onResume?.();
                  }),
              },
            ]
          : []),
        ...(missing.length === 0 && !canGoLocal && onSwitchModel != null
          ? [
              {
                key: "switch",
                mark: "abacus",
                name: t("workspace.switchModel"),
                meta: t("workspace.premiumUpgrade.switchNote"),
                cta: t("workspace.switchModel"),
                quiet: true,
                onClick: onSwitchModel,
              },
            ]
          : []),
      ];

  return (
    <div
      data-id={dataId}
      className="bg-card border-border overflow-hidden rounded-xl border"
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs">{note}</div>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="border-border flex items-center gap-3 border-t px-4 py-2.5"
          data-id={`${dataId}-row-${row.key}`}
        >
          <ProviderMark provider={row.mark} className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{row.name}</div>
            <div className="text-muted-foreground truncate text-[11px]">
              {row.meta}
            </div>
          </div>
          <Button
            size="sm"
            variant={row.quiet ? "secondary" : "default"}
            data-id={`${dataId}-${row.key}`}
            className={
              row.quiet
                ? "shrink-0"
                : "from-primary shrink-0 bg-gradient-to-b to-violet-700 font-semibold"
            }
            disabled={row.disabled}
            onClick={row.onClick}
          >
            {row.cta}
            {paying && <ArrowUpRight />}
          </Button>
        </div>
      ))}
      {keyDialog}
    </div>
  );
};

/** One way forward, as a row of the card. */
interface SourceRow {
  key: string;
  mark: string;
  name: string;
  meta: string;
  cta: string;
  /** A secondary button: the option after the free sources. */
  quiet?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** A `switch-model` action naming its target: what the card can offer. */
export interface FreeModelSwitch {
  model: string;
  label: string;
}

/** The named switches among an error's actions: the free models to offer. */
export const freeModelSwitches = (
  actions?: NotificationAction[]
): FreeModelSwitch[] =>
  (actions ?? []).flatMap((action) =>
    action.type === "switch-model" && action.model != null
      ? [{ model: action.model, label: action.label ?? action.model }]
      : []
  );

/** Whether an error's actions ask for the card instead of a red line. */
export const wantsUpgradeCard = (actions?: NotificationAction[]): boolean =>
  actions?.some(
    (action) =>
      action.type === "upgrade-abacus" || action.type === "free-pool-out"
  ) === true;

/**
 * What ran out: the Abacus.AI credits alone (`upgrade-abacus`), or every
 * source the router had (`free-pool-out`). The card's title says which.
 */
export const exhaustedScope = (
  actions?: NotificationAction[]
): "abacus" | "pool" =>
  actions?.some((action) => action.type === "upgrade-abacus") === true
    ? "abacus"
    : "pool";
