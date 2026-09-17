import { ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useCreditsStore } from "../../stores/credits-store";
import { Button } from "../ui";

/** The plan-selection page, so the upgrade lands on pricing. */
export const ABACUS_PLAN_URL = "https://apps.abacus.ai/chatllm/choose-plan/";

/**
 * The premium upsell: pinned under the model picker's list, and in the chat
 * where a turn died for want of credits (a red line quoting the provider's
 * JSON there reads as a crash rather than a plan boundary).
 */
export const PremiumUpgradeCard = ({
  exhausted = false,
  dataId,
  onBeforeOpen,
  freeModels = [],
  onPickModel,
}: {
  /** True in the chat: the copy says the credits are gone, not just upsells. */
  exhausted?: boolean;
  dataId: string;
  /** Runs before the browser hop — closing the popup the card sits in. */
  onBeforeOpen?: () => void;
  /** Models the platform still serves for free; each one is a way to keep going. */
  freeModels?: FreeModelSwitch[];
  onPickModel?: (modelId: string) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const markExhausted = useCreditsStore((state) => state.markExhausted);

  // A card standing where a turn died is the freshest word that the credits
  // are gone; the sidebar keeps showing the way out after this chat is gone.
  useEffect(() => {
    if (exhausted) markExhausted();
  }, [exhausted, markExhausted]);

  return (
    <div
      data-id={dataId}
      className="border-primary/35 from-primary/15 flex items-center gap-3 rounded-lg border bg-gradient-to-br to-violet-700/10 px-3.5 py-3"
    >
      <span className="from-primary shadow-primary/40 flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b to-violet-700 shadow-[0_2px_8px]">
        <Sparkles className="text-primary-foreground size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-semibold">
          {t(
            exhausted
              ? "workspace.premiumUpgrade.exhaustedTitle"
              : "workspace.premiumUpgrade.title"
          )}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {t(
            exhausted
              ? "workspace.premiumUpgrade.exhaustedNote"
              : "workspace.premiumUpgrade.note"
          )}
        </span>
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
      <Button
        size="sm"
        data-id={`${dataId}-cta`}
        className="from-primary shrink-0 bg-gradient-to-b to-violet-700 font-semibold"
        onClick={() => {
          onBeforeOpen?.();
          void window.api.openExternal(ABACUS_PLAN_URL);
        }}
      >
        {t("workspace.premiumUpgrade.cta")}
        <ArrowUpRight />
      </Button>
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
  actions?: Array<{ type: string; model?: string; label?: string }>
): FreeModelSwitch[] =>
  (actions ?? []).flatMap((action) =>
    action.type === "switch-model" && action.model != null
      ? [{ model: action.model, label: action.label ?? action.model }]
      : []
  );

/** Whether an error's actions ask for the upgrade card instead of a red line. */
export const wantsUpgradeCard = (actions?: Array<{ type: string }>): boolean =>
  actions?.some((action) => action.type === "upgrade-abacus") === true;
