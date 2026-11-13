/**
 * Moving what a chat left on to Abacus AI Agent on the web, which keeps it
 * running with the computer off: a site's deploy steps, a server's (whose
 * message asks to keep it running 24/7), or, for a routine, one button that
 * opens the agent with the routine typed in. The paid "keep it running"
 * card and the paid welcome both show it.
 */
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { markKind, type SiteReadyMark } from "@abacus-ai/contract/site-deploy";
import { abacusAgentPromptUrl } from "@abacus-ai/contract/toolsets";
import { useLiveQuery } from "@tanstack/react-db";
import type { TFunction } from "i18next";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { DeploySteps, type DeploySurface } from "./deploy-steps";

/** The card's title: the site's own, or "Keep “name” running 24/7". */
export const keepTitle = (t: TFunction, mark: SiteReadyMark): string =>
  markKind(mark) === "site"
    ? t("siteDeploy.title")
    : mark.name != null && mark.name.length > 0
      ? t("keepRunning.title", { name: mark.name })
      : t("keepRunning.titleUnnamed");

/** The welcome's title over the steps: the site's own, or "Move “name” to Abacus AI Agent". */
export const moveTitle = (t: TFunction, mark: SiteReadyMark): string =>
  markKind(mark) === "site"
    ? t("siteDeploy.title")
    : mark.name != null && mark.name.length > 0
      ? t("keepRunning.moveTitle", { name: mark.name })
      : t("keepRunning.moveTitleUnnamed");

/** A routine's message for the agent: what it does and when, from the routine itself. */
const routinePrompt = (
  t: TFunction,
  routine: { name: string; prompt: string; schedule: string | null } | null,
  name: string | null | undefined
): string =>
  routine == null
    ? t("keepRunning.routinePromptNameOnly", { name: name ?? "" })
    : routine.schedule != null
      ? t("keepRunning.routinePrompt", {
          name: routine.name,
          schedule: routine.schedule,
          prompt: routine.prompt,
        })
      : t("keepRunning.routinePromptOnce", {
          name: routine.name,
          prompt: routine.prompt,
        });

export const KeepSteps = ({
  sessionId,
  mark,
  surface,
}: {
  sessionId: string;
  mark: SiteReadyMark;
  surface: Exclude<DeploySurface, "card">;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const collections = useCollections();
  const kind = markKind(mark);
  const { data: routines } = useLiveQuery((q) =>
    q.from({ r: collections.routines })
  );
  const moved = () => {
    const step: FunnelStep =
      surface === "welcome" ? "paid_welcome_move" : "keep_running_move";
    void transport.client.system
      .funnelStep({ step, detail: kind })
      .catch(() => undefined);
  };
  if (kind === "routine")
    return (
      <div>
        <Button
          size="sm"
          data-step="set-up-routine"
          onClick={() => {
            moved();
            // The newest routine of that name: the one this chat made.
            const routine =
              (routines ?? [])
                .filter((row) => row.name === mark.name)
                .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
            void platformSystem(transport.client).openExternal({
              url: abacusAgentPromptUrl(routinePrompt(t, routine, mark.name)),
            });
          }}
        >
          {t("keepRunning.setUp")}
          <ArrowUpRight aria-hidden />
        </Button>
      </div>
    );
  return (
    <DeploySteps
      sessionId={sessionId}
      turnId={mark.turnId}
      surface={surface}
      prompt={kind === "server" ? t("keepRunning.prompt") : undefined}
      onOpenAgent={surface === "welcome" || kind !== "site" ? moved : undefined}
    />
  );
};
