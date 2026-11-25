/**
 * The success pitch's card (contract success-pitch.ts): under the latest
 * reply, right after a free account got a good result. What they got, the
 * plan's price and its whole pitch (the upgrade dialog's own list), Upgrade
 * (the dialog's checkout) and Not now. Main stamps the offer when the turn
 * closes; this shows it and keeps the answer.
 *
 * The same slot holds the big-build card (the chat's task, the plan's top
 * model) and the free "keep it running 24/7" card (what was left on, which
 * a personal agent on the web keeps running), each with its own events and
 * upgrade source; "keep it running" keeps its own budget.
 */
import {
  type BillingPlan,
  planPrice,
  type PitchLine,
  planTopModelIds,
  type UpgradeSrc,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import {
  creditAccountKey,
  pendingThreshold,
} from "@abacus-ai/contract/credit-thresholds";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { retryOfferModel } from "@abacus-ai/contract/retry-offer";
import {
  type KeepKind,
  pitchCaps,
  SUCCESS_PITCH_MOMENT_COPY,
  type SuccessPitchCard as SuccessPitchCardState,
  type SuccessPitchLead,
  type SuccessPitchMoment,
  type SuccessPitchOffer,
  successPitchAllowed,
  successPitchPlace,
  type SuccessPitchPlace,
  type SuccessPitchTrigger,
  underHalfOfFreeCredits,
} from "@abacus-ai/contract/success-pitch";
import type { UIMessage } from "@tanstack/ai-client";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Layers, Moon, Sparkles, X } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { usePaymentRequired } from "#renderer/components/payment-required";
import { useCollections, useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import { creditsTier } from "#renderer/lib/credits";
import { payingAccount, upgradeSeen } from "#renderer/lib/upgrade";
import {
  requestPlanDialog,
  startPlanCheckout,
  useUpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import {
  PlanPitchList,
  upgradeCtaLabel,
} from "../../upgrade-dialog/plan-pitch";
import { useChatView } from "./context";
import { SiteDeployCard } from "./site-deploy-card";
import { useTailCardClaim } from "./tail-cards";

export interface SuccessPitchCardProps {
  moment: SuccessPitchMoment;
  lead: SuccessPitchLead | null;
  /** The plan as billing_plan reads it; the card needs its offer. */
  billing: BillingPlan;
  onUpgrade(): void;
  onNotNow(): void;
}

/** How a card under a reply is painted: an upgrade's violet, or the app's own card. */
const FRAME_TONES = {
  pitch: {
    card: "border-violet-200 bg-violet-50/70 dark:border-violet-900/70 dark:bg-violet-950/30",
    tile: "bg-violet-600 text-white",
    primary: "bg-violet-600 text-white hover:bg-violet-700",
  },
  plain: {
    card: "bg-background shadow-xs",
    tile: "bg-primary/10 text-primary",
    primary: "",
  },
} as const;

/**
 * A card under a reply (owner rule: an offer there is a card, never a pill
 * with grey text): an icon tile, a bold title and a line, anything else
 * the card says, then its button and Not now (or the card's own second way
 * on, `secondary`). A close button when given.
 */
export const OfferCardFrame = ({
  slot,
  moment,
  tone,
  icon,
  title,
  line,
  children,
  action,
  notNow,
  secondary,
  onClose,
}: {
  slot: string;
  moment?: string;
  tone: keyof typeof FRAME_TONES;
  icon: ReactNode;
  title: string;
  line: string;
  children?: ReactNode;
  /** The main button; `name` is its data-action. Without it the card's own children carry its controls. */
  action?: { label: string; name: string; onClick(): void };
  notNow?: { label: string; onClick(): void };
  /** In place of Not now: the card's own second way on. */
  secondary?: ReactNode;
  /** The corner X, with its label. */
  onClose?: { label: string; onClick(): void };
}) => {
  const colors = FRAME_TONES[tone];
  return (
    <div
      data-slot={slot}
      data-moment={moment}
      className={cn(
        "relative my-2 flex w-full max-w-[520px] gap-3 rounded-xl border p-3.5 text-sm",
        onClose != null && "pr-9",
        colors.card
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[9px]",
          colors.tile
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{title}</p>
          <p className="text-muted-foreground">{line}</p>
        </div>
        {children}
        {action != null && (notNow != null || secondary != null) && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Button
              size="sm"
              className={colors.primary}
              data-action={action.name}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
            {secondary ??
              (notNow != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  data-action="not-now"
                  onClick={notNow.onClick}
                >
                  {notNow.label}
                </Button>
              ))}
          </div>
        )}
      </div>
      {onClose != null && (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground absolute top-2 right-2 size-7"
          aria-label={onClose.label}
          data-action="close"
          onClick={onClose.onClick}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
};

/**
 * One pitch card: its icon and first lines, the plan's price, its whole
 * list (led by `lead`), Upgrade and Not now. A card with its own second way
 * on (`secondary`) shows that in place of Not now; without `onNotNow` it has
 * no close.
 */
export const PitchCardFrame = ({
  slot,
  moment,
  icon,
  title,
  line,
  lead,
  billing,
  cta,
  secondary,
  onUpgrade,
  onNotNow,
}: {
  slot: string;
  moment: string;
  icon: ReactNode;
  title: string;
  line: string;
  lead: PitchLine | null;
  billing: BillingPlan;
  /** The Upgrade button's words; the plan's by default. */
  cta?: string;
  /** The way on beside Upgrade, in place of Not now. */
  secondary?: ReactNode;
  onUpgrade(): void;
  onNotNow?: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const offer = wallOffer(billing);
  if (offer == null) return null;
  return (
    <OfferCardFrame
      slot={slot}
      moment={moment}
      tone="pitch"
      icon={icon}
      title={title}
      line={line}
      action={{
        label: cta ?? upgradeCtaLabel(t, offer),
        name: "upgrade",
        onClick: onUpgrade,
      }}
      secondary={secondary}
      {...(onNotNow != null && {
        notNow: { label: t("upgradeDialog.notNow"), onClick: onNotNow },
        onClose: { label: t("upgradeDialog.close"), onClick: onNotNow },
      })}
    >
      <p className="-mt-2 font-semibold" data-slot="success-pitch-price">
        {planPrice(t, offer, i18n.language)}
      </p>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs font-medium">
          {t("upgradeDialog.planTitle", { plan: offer.planName })}
        </p>
        <PlanPitchList billing={billing} lead={lead} />
      </div>
    </OfferCardFrame>
  );
};

export const SuccessPitchCard = ({
  moment,
  ...props
}: SuccessPitchCardProps) => {
  const { t } = useTranslation();
  const offer = wallOffer(props.billing);
  if (offer == null || !(moment in SUCCESS_PITCH_MOMENT_COPY)) return null;
  return (
    <PitchCardFrame
      slot="success-pitch"
      moment={moment}
      icon={<Sparkles className="size-4" />}
      title={t(
        SUCCESS_PITCH_MOMENT_COPY[
          moment as keyof typeof SUCCESS_PITCH_MOMENT_COPY
        ]
      )}
      line={t("successPitch.line", { plan: offer.planName })}
      {...props}
    />
  );
};

/** The free card for a big build: the chat's task, and the plan's top model to finish it. */
export const BigTaskCard = ({
  task,
  topModel,
  ...props
}: Omit<SuccessPitchCardProps, "moment" | "lead"> & {
  task: string | null;
  /** The model the plan unlocks, by its catalog name; null when unknown. */
  topModel: string | null;
}) => {
  const { t } = useTranslation();
  const offer = wallOffer(props.billing);
  if (offer == null) return null;
  return (
    <PitchCardFrame
      slot="big-task"
      moment="big_task"
      icon={<Layers className="size-4" />}
      title={
        task != null ? t("bigTask.title", { task }) : t("bigTask.titleUntitled")
      }
      line={
        topModel != null
          ? t("bigTask.line", { plan: offer.planName, model: topModel })
          : t("bigTask.lineNoModel", { plan: offer.planName })
      }
      lead="apps"
      {...props}
    />
  );
};

/** Where it runs today, per kind. */
const KEEP_NOW_COPY = {
  server: "keepRunning.now.server",
  site: "keepRunning.now.site",
  routine: "keepRunning.now.routine",
} as const satisfies Record<KeepKind, string>;

/** The free "keep it running 24/7" card: where it runs now, and the personal agent that keeps it on. */
export const KeepRunningCard = ({
  kind,
  name,
  ...props
}: Omit<SuccessPitchCardProps, "moment" | "lead"> & {
  kind: KeepKind;
  name: string | null;
}) => {
  const { t } = useTranslation();
  const offer = wallOffer(props.billing);
  if (offer == null) return null;
  return (
    <PitchCardFrame
      slot="keep-running"
      moment={kind}
      icon={<Moon className="size-4" />}
      title={
        name != null && name.length > 0
          ? t("keepRunning.title", { name })
          : t("keepRunning.titleUnnamed")
      }
      line={`${t(KEEP_NOW_COPY[kind])} ${t("keepRunning.freeLine", { plan: offer.planName })}`}
      lead="agents"
      {...props}
    />
  );
};

/** Each trigger's events and upgrade source. */
const TRIGGER_EVENTS: Record<
  SuccessPitchTrigger,
  {
    shown: FunnelStep;
    upgrade: FunnelStep;
    notNow: FunnelStep;
    src: UpgradeSrc;
  }
> = {
  positive_reaction: {
    shown: "success_pitch_shown",
    upgrade: "success_pitch_upgrade",
    notNow: "success_pitch_not_now",
    src: "success_pitch",
  },
  deliverable: {
    shown: "success_pitch_shown",
    upgrade: "success_pitch_upgrade",
    notNow: "success_pitch_not_now",
    src: "success_pitch",
  },
  big_task: {
    shown: "big_task_shown",
    upgrade: "big_task_upgrade",
    notNow: "big_task_not_now",
    src: "big_task",
  },
  keep_running: {
    shown: "keep_running_shown",
    upgrade: "keep_running_upgrade",
    notNow: "keep_running_not_now",
    src: "keep_running",
  },
};

/** The funnel's detail: the trigger, the big build's signal, or what to keep on. */
const triggerDetail = (offer: SuccessPitchOffer): string =>
  offer.trigger === "big_task"
    ? (offer.detail ?? "files")
    : offer.trigger === "keep_running"
      ? offer.moment
      : offer.trigger;

/** Where the card's answers are kept: "keep it running" on its own budget. */
const cardsKey = (
  trigger: SuccessPitchTrigger
): "keepRunningCards" | "successPitchCards" =>
  trigger === "keep_running" ? "keepRunningCards" : "successPitchCards";

/**
 * This chat's offer where `place` shows it, under its latest reply while
 * nothing runs: the offer, the plan, and its answers. Only for a free
 * account under half its free grant, under the caps, and never over
 * another card: the upgrade dialog, a credit milestone card owed, or the
 * payment screen. A read-only view never shows it. Without the plan it is
 * not shown at all, rather than half a pitch. Called only where `place` is
 * on screen, so an offer is counted shown only when it is.
 */
const useSuccessPitch = ({
  active,
  place,
}: {
  active: boolean;
  place: SuccessPitchPlace;
}) => {
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const payment = usePaymentRequired();
  const now = useNow();
  const key = creditAccountKey(account);
  const mark = key != null ? prefs.successPitch?.[key] : undefined;
  // The gallery previews an offer of its own, and keeps no answer to it.
  const preview = slots.successPitchOffer != null;
  const offer: SuccessPitchOffer | null =
    slots.successPitchOffer ?? mark?.offer ?? null;
  const trigger = offer?.trigger ?? "deliverable";
  const cardsAt = cardsKey(trigger);
  const cards = prefs.dismissals[cardsAt] ?? {};
  const card = key != null ? cards[key] : undefined;
  // "Keep it running" is on its own budget: the chat-app line is not one of its shows.
  const capsMark = trigger === "keep_running" ? undefined : mark;
  const milestoneOwed =
    key != null &&
    pendingThreshold(
      prefs.creditThresholds?.[key],
      prefs.dismissals.creditThresholdCards?.[key],
      account
    ) != null;
  const eligible =
    offer != null &&
    key != null &&
    successPitchPlace(offer) === place &&
    offer.sessionId === session.threadId &&
    card?.answered !== offer.id &&
    composer.readOnly == null &&
    !active &&
    creditsTier(account) === "free" &&
    underHalfOfFreeCredits(account?.credits_used, account?.credits_granted) &&
    !milestoneOwed &&
    payment.data == null;
  // Once on screen it stays until answered; a new one waits for the caps.
  const visible =
    eligible &&
    (card?.shownOffer === offer.id ||
      (!upgradeAsked &&
        successPitchAllowed(card, capsMark, now, pitchCaps(trigger))));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: visible,
    staleTime: 60_000,
  });
  const showing =
    visible && billing != null && wallOffer(billing) != null ? offer : null;
  const events = TRIGGER_EVENTS[trigger];

  const write = (next: SuccessPitchCardState): void => {
    if (preview) return;
    void db
      .updatePrefs({
        dismissals: { [cardsAt]: { ...cards, [key!]: next } },
      })
      .catch(() => undefined);
  };
  const base = (): SuccessPitchCardState => ({
    shown: card?.shown ?? 0,
    lastShownAt: card?.lastShownAt ?? null,
    notNow: card?.notNow ?? 0,
    shownOffer: card?.shownOffer ?? null,
    answered: card?.answered ?? null,
  });
  // The funnel's detail names the next step's row apart from the card.
  const detail = (seen: SuccessPitchOffer): string =>
    place === "next_step" ? place : triggerDetail(seen);
  const funnel = (step: FunnelStep, seen: SuccessPitchOffer): void => {
    if (preview) return;
    void transport.client.system
      .funnelStep({ step, detail: detail(seen) })
      .catch(() => undefined);
  };
  const shown = useEffectEvent((seen: SuccessPitchOffer) => {
    if (card?.shownOffer === seen.id) return;
    funnel(TRIGGER_EVENTS[seen.trigger].shown, seen);
    if (!preview)
      upgradeSeen(transport.client, TRIGGER_EVENTS[seen.trigger].src);
    const previous = base();
    write({
      ...previous,
      shown: previous.shown + 1,
      lastShownAt: Date.now(),
      shownOffer: seen.id,
    });
  });
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);

  return {
    account,
    offer: showing,
    billing: showing != null ? (billing ?? null) : null,
    /**
     * Upgrade: a card that shows the whole pitch opens checkout (inside the
     * click: the web build opens its tab there); a row that shows less
     * opens the upgrade dialog, which shows it.
     */
    upgrade: (how: "checkout" | "dialog"): void => {
      if (showing == null) return;
      if (how === "checkout") startPlanCheckout(transport.client, events.src);
      else requestPlanDialog(events.src);
      funnel(events.upgrade, showing);
      write({ ...base(), answered: showing.id });
    },
    notNow: (): void => {
      if (showing == null) return;
      funnel(events.notNow, showing);
      const previous = base();
      write({
        ...previous,
        notNow: previous.notNow + 1,
        answered: showing.id,
      });
    },
  };
};

/** The card for this chat's offer, under its latest reply (useSuccessPitch). */
export const SuccessPitchRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { session } = useChatView();
  const { transport } = useAppContext();
  const pitch = useSuccessPitch({ active, place: "card" });
  const { offer: showing, billing, account } = pitch;
  const bigTask = showing?.trigger === "big_task";
  // The big build's title: the chat's own title, which is the task in its words.
  const collections = useCollections();
  const chat = useLiveQuery({
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, session.threadId))
        .findOne(),
  }).data;
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: bigTask,
    staleTime: 60_000,
  });
  // Locked until the upgrade: the model the plan unlocks, never a name in code.
  const topModel =
    bigTask && billing != null && catalog != null
      ? (retryOfferModel(catalog, "locked", planTopModelIds(billing))?.label ??
        null)
      : null;

  // The offer is for the session's latest reply.
  const latestReply = messages.findLast((each) => each.role === "assistant");
  useTailCardClaim(
    session.threadId,
    showing != null && billing != null && !payingAccount(account)
      ? (latestReply?.id ?? showing.id)
      : null
  );
  // A paid plan is never pitched: its slot holds the deploy steps after a site.
  if (payingAccount(account)) return <SiteDeployCard active={active} />;
  if (showing == null || billing == null) return null;
  const answers = {
    billing,
    onUpgrade: () => pitch.upgrade("checkout"),
    onNotNow: pitch.notNow,
  };
  if (showing.trigger === "big_task") {
    const title = chat?.label?.trim() ?? "";
    return (
      <BigTaskCard
        task={title.length > 0 ? title : null}
        topModel={topModel}
        {...answers}
      />
    );
  }
  if (showing.trigger === "keep_running")
    return (
      <KeepRunningCard
        kind={showing.moment as KeepKind}
        name={showing.name ?? null}
        {...answers}
      />
    );
  return (
    <SuccessPitchCard
      moment={showing.moment}
      lead={showing.lead}
      {...answers}
    />
  );
};

/**
 * The plan's row in the next step's card, under its tasks, when a result
 * ended on a next step (contract success-pitch.ts `place: "next_step"`):
 * the plan by name, its price, and a tap that opens the upgrade dialog with
 * the plan's whole pitch. Nothing when no such offer is owed.
 */
export const NextStepPlanRow = ({
  active,
  replyId,
}: {
  active: boolean;
  /** The reply the next step's card sits under. */
  replyId?: string;
}) => {
  const { t, i18n } = useTranslation();
  const { session } = useChatView();
  const pitch = useSuccessPitch({ active, place: "next_step" });
  const offer = wallOffer(pitch.billing);
  // One upgrade ask under a reply, as with the pitch's own card.
  useTailCardClaim(
    session.threadId,
    pitch.offer != null && offer != null ? (replyId ?? pitch.offer.id) : null
  );
  if (pitch.offer == null || offer == null) return null;
  return (
    <button
      type="button"
      data-task="plan"
      className="group/task flex w-full items-center gap-3 bg-violet-50/70 px-3.5 py-2.5 text-left outline-none hover:bg-violet-100/70 focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:ring-inset dark:bg-violet-950/30 dark:hover:bg-violet-950/50"
      onClick={() => pitch.upgrade("dialog")}
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white"
      >
        <Sparkles className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium [overflow-wrap:anywhere]">
          {t("successPitch.nextStep.title", { plan: offer.planName })}
        </span>
        <span className="text-muted-foreground text-xs">
          {planPrice(t, offer, i18n.language)}
        </span>
      </span>
      <ArrowRight
        aria-hidden
        className="text-muted-foreground group-hover/task:text-foreground size-4 shrink-0 transition-colors"
      />
    </button>
  );
};
