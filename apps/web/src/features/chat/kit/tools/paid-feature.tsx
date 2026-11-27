/**
 * `paid_feature`'s card: a capability the paid plans include, named. A free
 * account gets the plan's price and the upgrade; a paid one whose plan makes
 * it on the web gets Abacus AI Agent there, with the request filled in.
 */
import {
  abacusAgentPromptUrl,
  PAID_FEATURES,
  PLAN_FIRST_FEATURES,
} from "@abacus-ai/contract/toolsets";
import { parsePartialJSON, type UIMessage } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { UpgradeSeen } from "#renderer/components/upgrade-seen";
import { isPaidFeatureTool } from "#renderer/lib/bot-turns/turns";
import { onPlanActive } from "#renderer/lib/upgrade";
import { requestPlanDialog } from "#renderer/lib/upgrade-dialog";
import { Button } from "#renderer/ui/button";

import type { ChatHostActions } from "../../runtime/host-actions";
import { useHost, useThreadStore } from "../../store/selectors";
import { useChatView } from "../context";
import { useSendAsUser } from "../send-as-user";
import { toolInput } from "./normalize";
import { isLatestOffer, SuggestedTaskList } from "./suggested-tasks";

type Tier = Awaited<ReturnType<ChatHostActions["accountTier"]>>;

export const PaidFeatureCard = ({
  feature,
  prompt,
  host,
}: {
  feature: string;
  /** The request in the user's words, carried to the web. */
  prompt?: string;
  host: Pick<ChatHostActions, "accountTier" | "openUpgrade" | "openExternal">;
}) => {
  const { t } = useTranslation();
  const [tier, setTier] = useState<Tier>("unknown");
  const known = PAID_FEATURES.find((entry) => entry.feature === feature);
  const free = tier === "free";
  const web = (tier === "basic" || tier === "paid") && known?.inApp === false;
  useEffect(() => {
    let live = true;
    const read = () =>
      host
        .accountTier()
        .then((next) => {
          if (live) setTier(next);
        })
        .catch(() => {});
    void read();
    // A plan bought while the card is up: it speaks for the new plan at once.
    const stop = onPlanActive(() => void read());
    return () => {
      live = false;
      stop();
    };
  }, [host]);
  if (known == null) return null;
  const name = t(`capabilities.toolsets.${known.feature}.label`);
  return (
    <div data-slot="paid-feature" data-feature={feature}>
      {(free || web) && (
        <div className="bg-card my-2 flex w-full max-w-[520px] flex-col gap-2 rounded-xl border p-3">
          <div className="flex items-center gap-2">
            <Sparkles
              aria-hidden
              className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
            />
            <span className="text-sm font-medium">
              {t(
                web
                  ? "chat.paidFeature.agentTitle"
                  : known.inApp
                    ? "chat.paidFeature.title"
                    : "chat.paidFeature.webTitle",
                { feature: name }
              )}
            </span>
          </div>
          {!known.inApp && (
            <p className="text-muted-foreground text-xs leading-4">
              {t(
                web ? "chat.paidFeature.agentBody" : "chat.paidFeature.webBody"
              )}
            </p>
          )}

          <div>
            {web ? (
              <Button
                size="sm"
                onClick={() =>
                  void host.openExternal(abacusAgentPromptUrl(prompt))
                }
              >
                {t("chat.paidFeature.openAgent")}
                <ExternalLink aria-hidden className="size-3" />
              </Button>
            ) : (
              // The plan's whole pitch and price are the upgrade dialog's.
              <Button
                size="sm"
                data-action="see-plan"
                onClick={() => requestPlanDialog("paid_feature")}
              >
                <UpgradeSeen src="paid_feature" />
                {t("creditsCard.cta")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** The newest plan-step call for `feature`: a plan written twice still gets one button. */
const lastPlanStep = (
  messages: readonly UIMessage[],
  feature: string
): string | null => {
  let last: string | null = null;
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type !== "tool-call" || !isPaidFeatureTool(part.name)) continue;
      const input = toolInput(part as never, parsePartialJSON);
      if (input.step === "plan" && input.feature === feature) last = part.id;
    }
  return last;
};

/**
 * The free plan's plan step: one Generate button under the plan, whatever the
 * reply offers, until the user writes again. Its tap is their "generate it".
 */
const GenerateOffer = ({ id, feature }: { id: string; feature: string }) => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const sendAsUser = useSendAsUser();
  const messages = useHost(session, (state) => state.messages);
  const running = useThreadStore(session, (state) => state.runs.active != null);
  // A tap answers it at once: a second tap must not send again.
  const [sent, setSent] = useState(false);
  if (
    sent ||
    running ||
    composer.readOnly != null ||
    !isLatestOffer(messages, id) ||
    lastPlanStep(messages, feature) !== id
  )
    return null;
  const text = t(`chat.paidFeature.generate.${feature}`);
  return (
    <div data-slot="paid-feature-generate" data-feature={feature}>
      <SuggestedTaskList
        tasks={[{ text, copy: false, routine: false }]}
        nextStep={false}
        copied={null}
        onTap={() => {
          setSent(true);
          sendAsUser(text, {
            accepted: () => {},
            failed: () => setSent(false),
          });
        }}
      />
    </div>
  );
};

/** The tool row: the plan step's Generate button, else the card for the feature the call names. */
export const PaidFeatureToolCard = ({ part }: ToolProps<unknown>) => {
  const { runtime } = useChatView();
  const input = toolInput(part, parsePartialJSON);
  if (part.input == null || typeof input.feature !== "string") return null;
  if (input.step === "plan" && PLAN_FIRST_FEATURES.has(input.feature))
    return <GenerateOffer id={part.id} feature={input.feature} />;
  return (
    <PaidFeatureCard
      feature={input.feature}
      {...(typeof input.prompt === "string" ? { prompt: input.prompt } : {})}
      host={runtime.host}
    />
  );
};
