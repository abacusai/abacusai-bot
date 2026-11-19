/**
 * The server's top-model retry 50/50 (the billing plan's `opusRetry`): what a
 * free account's "retry on a top model" tap does, on the retry offer and on
 * the card under a reply. "opus": a new chat on the paid plans' Opus, run on
 * the account's own credits. "dialog": the upgrade dialog. Null for a paid
 * plan, an older server, or with the test off; those keep the dialog.
 */
import type { OpusRetryArm } from "@abacus-ai/contract/billing-plan";
import {
  modelIdentity,
  TOP_MODEL_FAMILIES,
} from "@abacus-ai/contract/retry-offer";
import { useQuery } from "@tanstack/react-query";

import { creditsTier } from "#renderer/lib/credits";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** The free account's arm; null until the plan is read. */
export const useOpusRetryArm = (): OpusRetryArm | null => {
  const { transport } = useAppContext();
  const { data: account } = useAccount();
  const free = creditsTier(account) === "free";
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: free,
    staleTime: 60_000,
  });
  return free ? (billing?.opusRetry ?? null) : null;
};

/**
 * The model is the paid plans' Opus a free account in the "opus" arm runs on
 * its own credits: the catalog lists it locked (the free plan's picker sells
 * it), but a chat already on it runs, so the composer shows it as usable.
 */
export const useOpusRetryRuns = (model: string | null | undefined): boolean => {
  const { transport } = useAppContext();
  const arm = useOpusRetryArm();
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: arm === "opus" && model != null,
    staleTime: 60_000,
  });
  return (
    arm === "opus" &&
    model != null &&
    (billing?.topModels ?? []).some(
      (each) =>
        each.agentic !== false &&
        modelIdentity(each.id).family === TOP_MODEL_FAMILIES.opus &&
        `abacus/${each.id}` === model
    )
  );
};
