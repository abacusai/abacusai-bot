/**
 * The welcome right after a payment lands: the plan and its credits, what
 * changed, and up to three next steps. It replaces the after-upgrade routines
 * card and takes over the turn the upgrade paused (lib/paid-welcome.ts).
 */
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { funnelDetail, type FunnelStep } from "@abacus-ai/contract/funnel";
import { OPENLLM_ID } from "@abacus-ai/contract/models";
import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowUpRight,
  Bot,
  ChevronRight,
  ImagePlus,
  Moon,
  Play,
  Plug,
  Sparkles,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { DeploySteps } from "#renderer/components/site-deploy/deploy-steps";
import { useCollections, useDb } from "#renderer/data/db";
import { useUpdatePrefs } from "#renderer/data/db/prefs";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { cn } from "#renderer/lib/cn";
import { accountTier, creditsTier, upgradePitch } from "#renderer/lib/credits";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  paidWelcomeDecision,
  registerPaidWelcome,
  type LandedFrom,
  type PausedTurn,
  type WelcomeDecision,
} from "#renderer/lib/paid-welcome";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { payingAccount } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

/** The one thing the plan unlocks that fits how the person uses the app. */
export type WelcomeUnlock = "apps" | "media" | "connectors";

export const welcomeUnlock = (
  account: AbacusAccountInfo | null | undefined
): WelcomeUnlock => {
  const pitch = upgradePitch(account);
  return pitch === "bots"
    ? "connectors"
    : pitch === "sessions"
      ? "apps"
      : "media";
};

export type WelcomeStep = "resume" | "routines" | "unlock";

/** Credits the account has left, by its counters; null when it does not say. */
export const welcomeCredits = (
  account: AbacusAccountInfo | null | undefined
): number | null =>
  account?.credits_granted != null && account.credits_used != null
    ? Math.max(0, account.credits_granted - account.credits_used)
    : null;

const ChangeRow = ({ icon, text }: { icon: ReactNode; text: string }) => (
  <li className="flex items-center gap-2.5 text-sm/5">
    <span
      aria-hidden
      className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-lg"
    >
      {icon}
    </span>
    <span className="min-w-0">{text}</span>
  </li>
);

const StepButton = ({
  icon,
  label,
  detail,
  external,
  primary,
  step,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  external: boolean;
  primary: boolean;
  step: WelcomeStep;
  onClick: () => void;
}) => (
  <Button
    variant={primary ? "default" : "secondary"}
    data-step={step}
    className="h-auto min-h-11 w-full justify-start gap-2.5 px-3 py-2 text-start text-sm font-semibold"
    onClick={onClick}
  >
    <span aria-hidden className="flex size-5 shrink-0 items-center">
      {icon}
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span>{label}</span>
      {detail != null && (
        <span
          className={cn(
            "truncate text-xs font-normal",
            primary ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          {detail}
        </span>
      )}
    </span>
    {external ? (
      <ArrowUpRight aria-hidden className="shrink-0" />
    ) : (
      <ChevronRight aria-hidden className="shrink-0" />
    )}
  </Button>
);

/**
 * The welcome itself. `credits` and `model` are null when unknown, and then
 * not shown; `paused` is the waiting message, or "" for a turn with none.
 * `deploy`, when the chat's latest result is a site, takes the place of the
 * next steps: its deploy steps, with the paused turn still offered under them.
 */
export const PaidWelcomeDialog = ({
  open,
  planName,
  credits,
  model,
  paused,
  unlock,
  deploy = null,
  onStep,
  onClose,
}: {
  open: boolean;
  planName: string | null;
  credits: number | null;
  model: string | null;
  paused: string | null;
  unlock: WelcomeUnlock;
  deploy?: ReactNode;
  onStep: (step: WelcomeStep) => void;
  onClose: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const unlockIcon =
    unlock === "apps" ? (
      <AppWindow className="size-4" />
    ) : unlock === "media" ? (
      <ImagePlus className="size-4" />
    ) : (
      <Plug className="size-4" />
    );
  const steps: { step: WelcomeStep; node: (primary: boolean) => ReactNode }[] =
    [
      ...(paused != null
        ? [
            {
              step: "resume" as const,
              node: (primary: boolean) => (
                <StepButton
                  key="resume"
                  step="resume"
                  primary={primary}
                  external={false}
                  icon={<Play className="size-4" />}
                  label={t("paidWelcome.resume")}
                  {...(paused.length > 0 && {
                    detail: t("paidWelcome.resumeDetail", { text: paused }),
                  })}
                  onClick={() => onStep("resume")}
                />
              ),
            },
          ]
        : []),
      {
        step: "routines",
        node: (primary) => (
          <StepButton
            key="routines"
            step="routines"
            primary={primary}
            external
            icon={<Moon className="size-4" />}
            label={t("paidWelcome.routines")}
            onClick={() => onStep("routines")}
          />
        ),
      },
      {
        step: "unlock",
        node: (primary) => (
          <StepButton
            key="unlock"
            step="unlock"
            primary={primary}
            external={unlock !== "connectors"}
            icon={unlockIcon}
            label={t(
              unlock === "apps"
                ? "paidWelcome.unlockApps"
                : unlock === "media"
                  ? "paidWelcome.unlockMedia"
                  : "paidWelcome.unlockConnectors"
            )}
            onClick={() => onStep("unlock")}
          />
        ),
      },
    ];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && (
        <DialogContent
          showCloseButton={false}
          data-slot="paid-welcome"
          data-deploy={deploy != null ? "" : undefined}
          className={cn(
            "max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-7 pb-5 text-sm [&>*]:min-w-0",
            deploy != null ? "sm:max-w-[480px]" : "sm:max-w-[440px]"
          )}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              aria-hidden
              className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
            >
              <Sparkles className="size-6" />
            </span>
            <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
              {planName
                ? t("paidWelcome.title", { plan: planName })
                : t("paidWelcome.titleNoPlan")}
            </DialogTitle>
            {credits != null && (
              <p
                className="text-muted-foreground text-sm/[21px]"
                data-slot="paid-welcome-credits"
              >
                {t("paidWelcome.credits", {
                  credits: new Intl.NumberFormat(i18n.language).format(credits),
                })}
              </p>
            )}
          </div>
          <ul
            className="flex flex-col gap-2.5"
            data-slot="paid-welcome-changes"
          >
            {model != null && (
              <ChangeRow
                icon={<Bot className="size-4" />}
                text={t("paidWelcome.model", { model })}
              />
            )}
            {deploy == null && (
              <ChangeRow
                icon={<Moon className="size-4" />}
                text={t("paidWelcome.agents")}
              />
            )}
          </ul>
          <div className="flex flex-col gap-1.5">
            {deploy != null ? (
              <>
                <p className="pb-2 text-base font-semibold">
                  {t("siteDeploy.title")}
                </p>
                {deploy}
                <div className="pt-3">
                  {steps.find((entry) => entry.step === "resume")?.node(false)}
                </div>
              </>
            ) : (
              <>
                <p className="text-muted-foreground text-xs font-medium tracking-[0.02em]">
                  {t("paidWelcome.nextSteps")}
                </p>
                {steps.map((entry, index) => entry.node(index === 0))}
              </>
            )}
            <Button
              variant="ghost"
              className="text-muted-foreground mt-1 h-10 text-sm"
              onClick={onClose}
            >
              {t("paidWelcome.back")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};

interface Showing {
  account: AbacusAccountInfo;
  paused: PausedTurn | null;
  /** The chat's latest site, when its latest result is one: the deploy steps lead. */
  site: { sessionId: string; turnId: string } | null;
}

/**
 * Once per upgrade, on the desktop: the welcome for the account a payment
 * moved up, read off the account (a paid read after a free one) or handed
 * over by the upgrade dialog with the turn it paused.
 */
export const PaidWelcomeHost = () => {
  const { transport } = useAppContext();
  const db = useDb();
  const collections = useCollections();
  const prefs = useLiveQuery(collections.prefs).data?.[0];
  const update = useUpdatePrefs();
  const live = useAccount().data;
  const navigate = useAppNavigate();
  // The chat on screen, for a payment that landed without the upgrade dialog.
  const onScreen =
    (useParams({ strict: false }) as { sessionId?: string }).sessionId ?? null;
  const [showing, setShowing] = useState<Showing | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const showingRef = useRef<Showing | null>(null);
  const landed = useRef(false);

  const funnel = (step: FunnelStep, detail?: string) =>
    void transport.client.system
      .funnelStep({
        step,
        ...(detail != null && { detail: funnelDetail(detail) }),
      })
      .catch(() => {});

  const apply = (decision: WelcomeDecision): void => {
    if (decision.write != null)
      void update({ dismissals: decision.write }).catch(() => undefined);
  };

  const siteOf = (chatId: string | null | undefined): Showing["site"] => {
    const mark =
      chatId == null
        ? null
        : db.collections.prefs.get("app")?.siteReady?.[chatId];
    return mark == null || chatId == null
      ? null
      : { sessionId: chatId, turnId: mark.turnId };
  };

  const show = (next: Showing) => {
    showingRef.current = next;
    setShowing(next);
    setModel(null);
    funnel(
      "paid_welcome_shown",
      `${accountTier(next.account) ?? "paid"}_${next.paused != null ? "paused" : "none"}`
    );
    if (next.site != null) funnel("site_deploy_shown", "welcome");
    // The plan's catalog, so the model named is the one the plan now defaults to.
    void transport.client.models
      .list({ refresh: true })
      .then((models) => {
        const pick = models.find(
          (entry) => entry.recommended === true && entry.configured
        );
        if (
          showingRef.current === next &&
          pick != null &&
          pick.id !== OPENLLM_ID
        )
          setModel(pick.label);
      })
      .catch(() => {});
  };

  // The upgrade dialog's landing: shows (or joins the open welcome) with its paused turn.
  const offer = useEffectEvent(
    (
      fresh: AbacusAccountInfo,
      from: AbacusAccountInfo | null,
      { threadId, paused }: LandedFrom
    ): boolean => {
      const open = showingRef.current;
      if (open != null) {
        const next = {
          account: fresh,
          paused: paused ?? open.paused,
          site: open.site ?? siteOf(threadId),
        };
        showingRef.current = next;
        setShowing(next);
        return true;
      }
      const row = db.collections.prefs.get("app");
      if (row == null) return false;
      const decision = paidWelcomeDecision(row.dismissals, fresh, from);
      apply(decision);
      if (!decision.show) return false;
      landed.current = true;
      show({
        account: fresh,
        paused,
        site: siteOf(threadId) ?? siteOf(onScreen),
      });
      return true;
    }
  );
  useEffect(() => {
    if (!IS_ELECTRON) return;
    return registerPaidWelcome((fresh, from, landing) =>
      offer(fresh, from, landing)
    );
  }, []);

  // A payment that landed elsewhere (the web, another surface): the next account read.
  const passive = useEffectEvent(
    (row: NonNullable<typeof prefs>, account: AbacusAccountInfo) => {
      if (showingRef.current != null) return;
      // The free read cached from before a landing this app watched is not a downgrade.
      if (landed.current && !payingAccount(account)) return;
      landed.current = false;
      if (
        creditsTier(account) === "free" &&
        row.dismissals.freePlanSeenAt == null
      )
        void update({ dismissals: { freePlanSeenAt: Date.now() } }).catch(
          () => undefined
        );
      const decision = paidWelcomeDecision(row.dismissals, account);
      apply(decision);
      if (decision.show)
        show({ account, paused: null, site: siteOf(onScreen) });
    }
  );
  useEffect(() => {
    // Read before writing: unread prefs would stamp an account seen before.
    // The welcome opens on an account read that arrives from main, once.
    // eslint-disable-next-line react/set-state-in-effect
    if (IS_ELECTRON && prefs != null && live != null) passive(prefs, live);
  }, [prefs, live]);

  const close = (step: WelcomeStep | null) => {
    const open = showingRef.current;
    showingRef.current = null;
    setShowing(null);
    if (open == null) return;
    if (step == null) {
      funnel("paid_welcome_closed");
      return;
    }
    const unlock = welcomeUnlock(open.account);
    if (step === "resume") {
      funnel("paid_welcome_resume");
      void open.paused?.resume().catch(() => {});
    } else if (step === "routines") {
      funnel("paid_welcome_routines");
      void platformSystem(transport.client).openExternal({
        url: ABACUS_AGENT_URL,
      });
    } else {
      funnel("paid_welcome_unlock", unlock);
      if (unlock === "connectors") void navigate({ to: "/library/connectors" });
      else
        void platformSystem(transport.client).openExternal({
          url: ABACUS_AGENT_URL,
        });
    }
  };

  // A paid read since the welcome opened has the newest balance.
  const account =
    showing != null && payingAccount(live) ? live : showing?.account;
  return (
    <PaidWelcomeDialog
      open={showing != null}
      planName={account?.plan ?? null}
      credits={welcomeCredits(account)}
      model={model}
      paused={showing?.paused == null ? null : (showing.paused.text ?? "")}
      unlock={welcomeUnlock(account)}
      deploy={
        showing?.site == null ? null : (
          <DeploySteps
            sessionId={showing.site.sessionId}
            turnId={showing.site.turnId}
            surface="welcome"
          />
        )
      }
      onStep={close}
      onClose={() => close(null)}
    />
  );
};
