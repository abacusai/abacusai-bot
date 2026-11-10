/**
 * The top-model hint (contract top-model-hint.ts): a paying plan's chat on
 * its low-cost router, one line above the composer offering the plan's Sonnet
 * and Opus in one tap each, and the model picker for the rest. A model's tap
 * continues this work in a new chat on it, from a summary of this one
 * (continue-chat.ts); this chat and the app's default keep their model. Only
 * a listed session chat has it. It waits for a quiet turn: never
 * while a run is going, after a failed one, or under a reply that has a card
 * of its own (a retry, a document offer, task buttons, a success pitch), and
 * it steps aside once half the month's credits are used, where the credit
 * cards speak. Caps live in prefs.
 */
import { currentPlanTopModelNames } from "@abacus-ai/contract/billing-plan";
import { isSuggestTasksTool } from "@abacus-ai/contract/bots/suggested-tasks";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  EMPTY_TOP_MODEL_HINT_CARD,
  type TopModelHintCard,
  topModelHintAllowed,
  topModelHintChoices,
  topModelHintCreditsSpent,
  topModelHintShowing,
  topModelHintShown,
} from "@abacus-ai/contract/top-model-hint";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import { turnsOf } from "#renderer/lib/bot-turns/turns";
import { showError } from "#renderer/lib/toast";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useChatView } from "../kit/context";
import { deliverableOfferTarget } from "../kit/deliverable-offer";
import { openModelPicker } from "../kit/open-model-picker";
import { retryOfferTarget, successPitchOnThread } from "../kit/retry-offer";
import { useHost, useThreadStore } from "../store/selectors";

/** The latest reply ended with tap-to-run task buttons of its own. */
const endedOnTasks = (messages: readonly UIMessage[]): boolean => {
  const turn = turnsOf(messages).at(-1);
  return (
    turn?.assistantIndices.some((index) =>
      messageTools(messages[index]!).some((tool) =>
        isSuggestTasksTool(tool.name)
      )
    ) === true
  );
};

/** The model's family, the beacons' detail. */
const family = (label: string): "sonnet" | "opus" =>
  /opus/i.test(label) ? "opus" : "sonnet";

export const TopModelHint = ({
  threadId,
  tier,
}: {
  threadId: string;
  /** The paying plan's tier, the shown beacon's detail. */
  tier: string;
}) => {
  const { t } = useTranslation();
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const messages = useHost(session, (state) => state.messages);
  const outbox = useHost(session, (state) => state.outbox.length);
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const running = useThreadStore(session, (state) => state.runs.active != null);
  // A close or a tap hides it at once, before the prefs write lands.
  const [answered, setAnswered] = useState(false);
  // The model whose new chat is being prepared, with the line still up.
  const [preparing, setPreparing] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  // The gallery shows it on models of its own, and keeps no record.
  const preview = slots.topModelHintPreview ?? null;
  const card = preview != null ? null : (prefs.dismissals.topModelHint ?? null);
  const turn = turnsOf(messages).length;
  const at = { threadId, turn };
  const showingNow = topModelHintShowing(card, at);
  const quiet =
    turn >= 1 &&
    !running &&
    outbox === 0 &&
    outcome?.kind === "success" &&
    composer.readOnly == null;
  const othersHere =
    retryOfferTarget(messages) != null ||
    deliverableOfferTarget(messages) != null ||
    endedOnTasks(messages) ||
    successPitchOnThread(prefs, threadId);
  const may =
    !answered &&
    quiet &&
    !othersHere &&
    composer.onContinueInNewChat != null &&
    (preview != null ||
      (account != null &&
        !topModelHintCreditsSpent(account) &&
        (showingNow || topModelHintAllowed(card, { threadId, now }))));

  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: may && preview == null,
    staleTime: 60_000,
  });
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: may && preview == null,
    staleTime: 60_000,
  });
  const choices = !may
    ? []
    : preview != null
      ? preview.choices
      : billing != null && catalog != null
        ? topModelHintChoices(currentPlanTopModelNames(billing), catalog)
        : [];
  const visible = choices.length > 0;

  const write = (next: TopModelHintCard): void => {
    if (preview != null) return;
    void db
      .updatePrefs({ dismissals: { topModelHint: next } })
      .catch(() => undefined);
  };
  const funnel = (step: FunnelStep, detail: string): void => {
    if (preview != null) return;
    void transport.client.system
      .funnelStep({ step, detail })
      .catch(() => undefined);
  };

  // Counted once per chat, when it first comes on screen.
  const shown = useEffectEvent(() => {
    if (showingNow) return;
    funnel("top_model_hint_shown", tier);
    write(topModelHintShown(card, at));
  });
  useEffect(() => {
    if (visible) shown();
  }, [visible]);

  if (!visible) return null;
  const base = card ?? EMPTY_TOP_MODEL_HINT_CARD;

  const pick = async (model: { id: string; label: string }) => {
    const which = family(model.label);
    funnel("top_model_hint_tapped", which);
    setPreparing(model.id);
    try {
      await composer.onContinueInNewChat?.(model.id);
    } catch {
      // Nothing opened: the line stays for another try.
      showError(t("chat.continuation.failed"));
      setPreparing(null);
      return;
    }
    setAnswered(true);
    funnel("top_model_hint_switched", which);
    write({ ...base, switched: true });
  };
  const close = () => {
    setAnswered(true);
    funnel("top_model_hint_dismissed", tier);
    write({
      ...base,
      dismissed: base.dismissed + 1,
      dismissedAt: Date.now(),
      shownTurn: null,
    });
  };
  const [first, second] = choices;

  return (
    <section data-slot="top-model-hint" className="mb-2">
      <div className="bg-card border-border overflow-hidden rounded-xl border">
        <div className="flex items-start gap-3 px-3 py-2.5 text-sm">
          <Sparkles
            aria-hidden
            className="text-primary mt-0.5 size-4 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-relaxed">
              {second != null
                ? t("chat.composer.topModels.line", {
                    first: first!.label,
                    second: second.label,
                  })
                : t("chat.composer.topModels.lineOne", {
                    model: first!.label,
                  })}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {choices.map((model) => (
                <Button
                  key={model.id}
                  size="sm"
                  variant={model === first ? "default" : "outline"}
                  className="h-7 rounded-lg"
                  data-model={model.id}
                  disabled={preparing != null}
                  onClick={() => void pick(model)}
                >
                  {preparing === model.id && (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  )}
                  {model.label}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg"
                data-action="all-models"
                onClick={(event) => {
                  funnel("top_model_hint_tapped", "all");
                  openModelPicker(event.currentTarget);
                }}
              >
                {t("chat.composer.topModels.all")}
              </Button>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground -mt-0.5 -mr-1 size-7 shrink-0 rounded-full"
            aria-label={t("chat.composer.topModels.dismiss")}
            data-action="dismiss"
            onClick={close}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
};
