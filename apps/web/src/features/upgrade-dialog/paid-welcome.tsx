/**
 * The welcome right after a payment lands: the plan and its credits, what
 * changed, and up to three next steps. It replaces the after-upgrade routines
 * card and takes over the turn the upgrade paused (lib/paid-welcome.ts): every
 * way of closing it sends that turn, once. It waits behind an upgrade dialog.
 */
import { planTopModelIds } from "@abacus-ai/contract/billing-plan";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { funnelDetail, type FunnelStep } from "@abacus-ai/contract/funnel";
import { OPENLLM_ID } from "@abacus-ai/contract/models";
import { retryOfferModel } from "@abacus-ai/contract/retry-offer";
import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowUpRight,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Hammer,
  ImagePlus,
  Inbox,
  Loader2,
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
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { useUpdatePrefs } from "#renderer/data/db/prefs";
import type { AppClient } from "#renderer/data/transport/types";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { cn } from "#renderer/lib/cn";
import { accountTier, creditsTier, upgradePitch } from "#renderer/lib/credits";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  paidWelcomeDecision,
  registerPaidWelcome,
  welcomeLastChat,
  welcomeLead,
  type LandedFrom,
  type PausedTurn,
  type WelcomeDecision,
  type WelcomeLead,
} from "#renderer/lib/paid-welcome";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError } from "#renderer/lib/toast";
import { payingAccount } from "#renderer/lib/upgrade";
import { useUpgradeDialogRequest } from "#renderer/lib/upgrade-dialog";
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

/** A first task on the top model, for someone with no chat to pick up. */
export type WelcomeTask = "build" | "inbox" | "business";

const WELCOME_TASKS: readonly WelcomeTask[] = ["build", "inbox", "business"];

const isWelcomeTask = (step: string): step is WelcomeTask =>
  (WELCOME_TASKS as readonly string[]).includes(step);

export type WelcomeStep =
  | "resume"
  | "routines"
  | "unlock"
  | "continue"
  | WelcomeTask;

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
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  external: boolean;
  primary: boolean;
  step: WelcomeStep;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <Button
    variant={primary ? "default" : "secondary"}
    data-step={step}
    disabled={disabled}
    className="h-auto min-h-11 w-full justify-start gap-2.5 px-3 py-2 text-start text-sm font-semibold whitespace-normal"
    onClick={onClick}
  >
    <span aria-hidden className="flex size-5 shrink-0 items-center">
      {icon}
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="[overflow-wrap:anywhere]">{label}</span>
      {detail != null && (
        <span
          className={cn(
            "line-clamp-2 text-xs font-normal [overflow-wrap:anywhere]",
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
 * `lead` picks the first steps (lib/paid-welcome.ts `welcomeLead`): the
 * paused turn, the last chat (`lastChat`, its title) on `topModel`, or three
 * first tasks on it; `none` keeps the plain ones. `busy` is the step whose
 * new chat is being prepared. `deploy`, when the chat's latest result is a
 * site, takes the place of the next steps: its deploy steps, with the paused
 * turn still offered under them.
 */
export const PaidWelcomeDialog = ({
  open,
  planName,
  credits,
  model,
  paused,
  topModel = null,
  lead: leadProp,
  lastChat = null,
  busy = null,
  unlock,
  deploy = null,
  onStep,
  onClose,
}: {
  open: boolean;
  planName: string | null;
  credits: number | null;
  model: string | null;
  topModel?: string | null;
  lead?: WelcomeLead;
  lastChat?: string | null;
  busy?: WelcomeStep | null;
  paused: string | null;
  unlock: WelcomeUnlock;
  deploy?: ReactNode;
  onStep: (step: WelcomeStep) => void;
  onClose: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const lead = leadProp ?? (paused == null ? "none" : "paused");
  const unlockIcon =
    unlock === "apps" ? (
      <AppWindow className="size-4" />
    ) : unlock === "media" ? (
      <ImagePlus className="size-4" />
    ) : (
      <Plug className="size-4" />
    );
  const step = (
    key: WelcomeStep,
    icon: ReactNode,
    label: string,
    options: { detail?: string; external?: boolean } = {}
  ) => ({
    step: key,
    node: (primary: boolean) => (
      <StepButton
        key={key}
        step={key}
        primary={primary}
        external={options.external ?? false}
        disabled={busy != null}
        icon={busy === key ? <Loader2 className="size-4 animate-spin" /> : icon}
        label={label}
        {...(options.detail != null && { detail: options.detail })}
        onClick={() => onStep(key)}
      />
    ),
  });
  const top = topModel ?? "";
  const taskStep = (task: WelcomeTask) =>
    task === "build"
      ? step("build", <Hammer className="size-4" />, t("paidWelcome.build"), {
          detail: t("paidWelcome.buildDetail", { model: top }),
        })
      : task === "inbox"
        ? step("inbox", <Inbox className="size-4" />, t("paidWelcome.inbox"), {
            detail: t("paidWelcome.inboxDetail"),
          })
        : step(
            "business",
            <BriefcaseBusiness className="size-4" />,
            t("paidWelcome.business"),
            { detail: t("paidWelcome.businessDetail") }
          );
  const plain = [
    step("routines", <Moon className="size-4" />, t("paidWelcome.routines"), {
      external: true,
    }),
    step(
      "unlock",
      unlockIcon,
      t(
        unlock === "apps"
          ? "paidWelcome.unlockApps"
          : unlock === "media"
            ? "paidWelcome.unlockMedia"
            : "paidWelcome.unlockConnectors"
      ),
      { external: unlock !== "connectors" }
    ),
  ];
  const resume =
    paused != null
      ? step("resume", <Play className="size-4" />, t("paidWelcome.resume"), {
          ...(paused.length > 0 && {
            detail: t("paidWelcome.resumeDetail", { text: paused }),
          }),
        })
      : null;
  const steps =
    lead === "task" && topModel != null
      ? WELCOME_TASKS.map(taskStep)
      : lead === "chat" && topModel != null && lastChat != null
        ? [
            step(
              "continue",
              <Play className="size-4" />,
              t("paidWelcome.continue", { title: lastChat, model: top }),
              { detail: t("paidWelcome.continueDetail") }
            ),
            ...plain,
          ]
        : [...(resume != null ? [resume] : []), ...plain];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && (
        <DialogContent
          showCloseButton={false}
          data-slot="paid-welcome"
          data-lead={lead}
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
            {topModel != null && model != null && topModel !== model ? (
              <ChangeRow
                icon={<Bot className="size-4" />}
                text={t("paidWelcome.models", { top: topModel, model })}
              />
            ) : (
              model != null && (
                <ChangeRow
                  icon={<Bot className="size-4" />}
                  text={t("paidWelcome.model", { model })}
                />
              )
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
                <div className="pt-3">{resume?.node(false)}</div>
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
              disabled={busy != null}
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
 * How the welcome opens a chat on the top model, handed in where it is
 * mounted (routes/-welcome-starts.ts): `continueChat` is #787's continue in a
 * new chat; `newTask` makes a fresh draft on `model` whose `prompt` the start
 * page sends at once, and returns its id. Without them the welcome keeps its
 * plain steps.
 */
export interface WelcomeStarts {
  continueChat(input: {
    client: AppClient;
    row: SessionRow;
    model: string;
    prompt: string;
    open(search: { workspace: string; draft: string }): Promise<unknown> | void;
  }): Promise<void>;
  newTask(model: string, prompt: string): string;
}

/** Read once the welcome opens: the plan's default and top model, and the chat to pick up. */
interface Prepared {
  model: string | null;
  top: { id: string; label: string } | null;
  lastChat: SessionRow | null;
}

/** Past this, the welcome opens with what it has: a slow catalog never hides it. */
const WELCOME_PREPARE_MS = 4000;

/**
 * Once per upgrade, on the desktop: the welcome for the account a payment
 * moved up, read off the account (a paid read after a free one) or handed
 * over by the upgrade dialog with the turn it paused.
 */
export const PaidWelcomeHost = ({
  starts = null,
}: {
  starts?: WelcomeStarts | null;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const db = useDb();
  const collections = useCollections();
  const prefs = useLiveQuery(collections.prefs).data?.[0];
  const update = useUpdatePrefs();
  const live = useAccount().data;
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const navigate = useAppNavigate();
  // The chat on screen, for a payment that landed without the upgrade dialog.
  const onScreen =
    (useParams({ strict: false }) as { sessionId?: string }).sessionId ?? null;
  const [showing, setShowing] = useState<Showing | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<WelcomeStep | null>(null);
  const showingRef = useRef<Showing | null>(null);
  const landed = useRef(false);
  // Bumped per welcome: a landing that joins the open one keeps its read going.
  const preparing = useRef(0);

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

  // The person's latest listed chat in a listed folder, when recent: what they were working on.
  const lastChat = (): SessionRow | null =>
    welcomeLastChat(
      db.collections.sessions.toArray.filter((row) => {
        const workspace = db.collections.workspaces.get(row.workspaceId);
        return (
          isListedSession(row) &&
          row.label.trim() !== "" &&
          workspace != null &&
          isListedWorkspace(workspace)
        );
      }),
      Date.now()
    );

  const show = (next: Showing) => {
    showingRef.current = next;
    setShowing(next);
    setPrepared(null);
    setBusy(null);
    const token = ++preparing.current;
    const ready = (found: Prepared) => {
      const open = showingRef.current;
      if (preparing.current !== token || open == null) return;
      preparing.current += 1;
      setPrepared(found);
      const lead = welcomeLead({
        paused: open.paused != null,
        lastChat: found.lastChat != null,
        topModel: found.top != null,
      });
      funnel(
        "paid_welcome_shown",
        `${accountTier(next.account) ?? "paid"}_${lead}`
      );
      if (open.site != null) funnel("site_deploy_shown", "welcome");
    };
    const timer = setTimeout(
      () => ready({ model: null, top: null, lastChat: null }),
      WELCOME_PREPARE_MS
    );
    // The plan's catalog: the model it now defaults to, and its top model.
    void Promise.all([
      transport.client.models.list({ refresh: true }).catch(() => []),
      transport.client.account.billingPlan({}).catch(() => null),
    ]).then(([models, billing]) => {
      clearTimeout(timer);
      const pick = models.find(
        (entry) => entry.recommended === true && entry.configured
      );
      const top = retryOfferModel(models, "runnable", planTopModelIds(billing));
      ready({
        model: pick != null && pick.id !== OPENLLM_ID ? pick.label : null,
        // No way to open a chat here: the plain steps, so none promises one.
        top:
          top == null || starts == null
            ? null
            : { id: top.id, label: top.label },
        lastChat: lastChat(),
      });
    });
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
    const unregister = registerPaidWelcome((fresh, from, landing) =>
      offer(fresh, from, landing)
    );
    return () => {
      unregister();
      // The host going away closes the welcome too.
      const open = showingRef.current;
      showingRef.current = null;
      void open?.paused?.resume().catch(() => {});
    };
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

  // A new chat on the top model: the last chat from its summary, or a first task.
  const startOnTop = async (
    step: "continue" | WelcomeTask,
    open: Showing
  ): Promise<void> => {
    const top = prepared?.top;
    if (top == null || starts == null) return;
    const tier = accountTier(open.account) ?? "paid";
    if (step === "continue") {
      const row = prepared?.lastChat;
      if (row == null) return;
      funnel("paid_welcome_continue", tier);
      await starts.continueChat({
        client: transport.client,
        row,
        model: top.id,
        prompt: t("paidWelcome.continuePrompt"),
        open: (search) =>
          navigate({
            to: "/sessions/new",
            search,
            transition: "nav-forward",
          }),
      });
      return;
    }
    funnel("paid_welcome_task", step);
    const draft = starts.newTask(
      top.id,
      t(
        step === "build"
          ? "paidWelcome.buildPrompt"
          : step === "inbox"
            ? "paidWelcome.inboxPrompt"
            : "paidWelcome.businessPrompt"
      )
    );
    await navigate({
      to: "/sessions/new",
      search: { draft },
      transition: "nav-forward",
    });
  };

  // Every way out: `open` is taken here, so the paused turn is sent once.
  const take = (): Showing | null => {
    const open = showingRef.current;
    showingRef.current = null;
    setShowing(null);
    void open?.paused?.resume().catch(() => {});
    return open;
  };

  const close = (step: WelcomeStep | null) => {
    if (step === "continue" || (step != null && isWelcomeTask(step))) {
      const open = showingRef.current;
      // The welcome stays, its step spinning, until the new chat opens.
      if (open == null || busy != null) return;
      setBusy(step);
      void startOnTop(step, open)
        .catch(() => showError(t("chat.continuation.failed")))
        .finally(() => {
          setBusy(null);
          if (showingRef.current === open) take();
        });
      return;
    }
    const open = take();
    if (open == null) return;
    if (step == null) {
      funnel("paid_welcome_closed");
      return;
    }
    const unlock = welcomeUnlock(open.account);
    if (step === "resume") funnel("paid_welcome_resume");
    else if (step === "routines") {
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
      open={showing != null && prepared != null && !upgradeAsked}
      planName={account?.plan ?? null}
      credits={welcomeCredits(account)}
      model={prepared?.model ?? null}
      topModel={prepared?.top?.label ?? null}
      lead={welcomeLead({
        paused: showing?.paused != null,
        lastChat: prepared?.lastChat != null,
        topModel: prepared?.top != null,
      })}
      lastChat={prepared?.lastChat?.label ?? null}
      busy={busy}
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
