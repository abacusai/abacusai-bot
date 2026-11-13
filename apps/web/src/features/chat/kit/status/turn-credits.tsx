/**
 * A finished turn's Abacus credits beside its "Done in", and on the latest
 * turn what is left; a click opens the plan (free) or the top-up and next
 * plan (paid). Only a turn whose own requests reported their charge shows it.
 */
import type { RunOutcomeRecord } from "@abacus-ai/contract/contract/ai-thread";
import { creditAccountKey } from "@abacus-ai/contract/credit-thresholds";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { creditsTier } from "#renderer/lib/credits";
import {
  balanceStore,
  foldRead,
  foldTurn,
  leftAfter,
  useBalanceCeiling,
} from "#renderer/lib/credits-left";
import { requestUpgradeDialog } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Under a fifth of the grant left: the count takes the attention colour. */
const LOW_SHARE = 0.2;

export const TurnCredits = ({
  outcome,
  latest,
}: {
  outcome: RunOutcomeRecord;
  latest: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const account = useAccount();
  const data = account.data;
  const ceiling = useBalanceCeiling();
  const key = creditAccountKey(data);
  const granted = data?.credits_granted ?? null;
  const used = data?.credits_used ?? null;
  const readAt = account.dataUpdatedAt;
  const credits = outcome.credits ?? 0;
  const shown = credits > 0 && outcome.freeLane == null;

  useEffect(() => {
    if (key == null || granted == null || !(granted > 0) || used == null)
      return;
    balanceStore.setState((state) => ({
      ceiling: foldRead(state.ceiling, {
        account: key,
        granted,
        used,
        at: readAt,
      }),
    }));
  }, [key, granted, used, readAt]);

  useEffect(() => {
    if (!latest || !shown) return;
    balanceStore.setState((state) => ({
      ceiling: foldTurn(state.ceiling, {
        runId: outcome.runId,
        startedAt: outcome.startedAt,
        credits,
      }),
    }));
  }, [latest, shown, outcome.runId, outcome.startedAt, credits]);

  const tier = creditsTier(data);
  if (!shown || tier === "unknown") return null;
  const left = latest ? leftAfter(ceiling, key, outcome) : null;
  const number = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 0,
  });
  const count = Math.max(1, Math.round(credits));
  const spent = credits < 1 ? "<1" : number.format(count);
  const label =
    left != null
      ? t("chat.run.creditsLeft", {
          credits: spent,
          left: number.format(Math.floor(left)),
          count,
        })
      : t("chat.run.credits", { credits: spent, count });
  const low = left != null && granted != null && left < granted * LOW_SHARE;

  return (
    <>
      <span aria-hidden className="text-muted-foreground text-xs select-none">
        ·
      </span>
      <button
        type="button"
        data-slot="turn-credits"
        data-low={low ? "" : undefined}
        aria-label={t("chat.run.creditsAction", { credits: label })}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1 flex min-h-7 cursor-pointer items-center rounded-md px-1 text-xs tabular-nums underline-offset-2 transition-colors outline-none select-none hover:underline focus-visible:ring-2 data-[low]:text-[var(--chat-status-attention)]"
        onClick={() => {
          void transport.client.system
            .funnelStep({ step: "turn_credits_clicked", detail: tier })
            .catch(() => undefined);
          requestUpgradeDialog(
            {
              kind: "balance",
              key: `balance:${outcome.runId}:${Date.now()}`,
              threadId: outcome.runId,
              src: "turn_credits",
            },
            true
          );
        }}
      >
        {label}
      </button>
    </>
  );
};
