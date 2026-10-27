/**
 * `paid_feature`'s card: a capability the paid plans include, named. A free
 * account gets the plan's price and the upgrade; a paid one whose plan makes
 * it on the web gets Abacus AI Agent there, with the request filled in.
 */
import {
  abacusAgentPromptUrl,
  PAID_FEATURES,
} from "@abacus-ai/contract/toolsets";
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requestPlanDialog } from "#renderer/lib/upgrade-dialog";
import { Button } from "#renderer/ui/button";

import type { ChatHostActions } from "../../runtime/host-actions";
import { useChatView } from "../context";
import { toolInput } from "./normalize";

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
    void host
      .accountTier()
      .then((next) => {
        if (live) setTier(next);
      })
      .catch(() => {});
    return () => {
      live = false;
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
                onClick={() => requestPlanDialog("paid-feature")}
              >
                {t("creditsCard.cta")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** The tool row: the card for the feature the call names. */
export const PaidFeatureToolCard = ({ part }: ToolProps<unknown>) => {
  const { runtime } = useChatView();
  const input = toolInput(part, parsePartialJSON);
  return part.input == null || typeof input.feature !== "string" ? null : (
    <PaidFeatureCard
      feature={input.feature}
      {...(typeof input.prompt === "string" ? { prompt: input.prompt } : {})}
      host={runtime.host}
    />
  );
};
