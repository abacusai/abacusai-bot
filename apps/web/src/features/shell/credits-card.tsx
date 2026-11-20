import {
  type BillingPlan,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import {
  CREDIT_THRESHOLD_COPY,
  creditAccountKey,
} from "@abacus-ai/contract/credit-thresholds";
import { streakCreditsLeft } from "@abacus-ai/contract/streak";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  FileText,
  Gauge,
  Globe,
  ImageIcon,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { AnimatePresence, motion, animate } from "motion/react";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useCurrentChat } from "#renderer/components/credits-card/current-chat";
import { StreakFlame } from "#renderer/components/streak/streak-week";
import { UpgradeSeen } from "#renderer/components/upgrade-seen";
import { usePrefs } from "#renderer/data/db/prefs";
import {
  ABACUS_AGENT_URL,
  ABACUS_VERIFY_PHONE_URL,
} from "#renderer/lib/abacus-links";
import { creditsTier } from "#renderer/lib/credits";
import {
  freeCreditsHeld,
  startFreeCreditsWatch,
  useFreeCreditsVerifySurface,
} from "#renderer/lib/free-credits-watch";
import {
  durations,
  easings,
  offsets,
  springs,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { platformSystem } from "#renderer/lib/platform-system";
import { openUpgrade } from "#renderer/lib/upgrade";
import { startPlanCheckout } from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import { PlanPitchList, upgradeCtaLabel } from "../upgrade-dialog/plan-pitch";
import {
  type CreditsCardContext,
  type CreditsCardLevel,
  creditsCardContext,
  estimateKey,
} from "./credits-card-context";
import { PromoCharacter } from "./promo-character";
import { usePromoHost, consumePromoRect } from "./promo-host";
import { promoAccountKey, promoState } from "./promo-state";

/** Under this share of the month's credits left, the card says they are running low. */
const LOW_CREDITS_SHARE = 0.2;
/** What a paid plan does on the web that the app does not. */
const WEB_LINES = [
  { key: "creditsCard.paidWebApps", icon: Globe },
  { key: "creditsCard.paidWebResearch", icon: FileText },
  { key: "creditsCard.paidWebMedia", icon: ImageIcon },
] as const;

/**
 * One portal, shown only inside the sidebar (pinned or peeked): a collapsed
 * sidebar hides it. A free account sees the upgrade card, or while its free
 * credits are held, the way to unlock them; a paid plan the card that points
 * at AbacusAI Agent on the web. The free card already lists the plan's whole
 * pitch, so its Upgrade goes straight to the payment page, with no dialog
 * repeating it; the account is watched until the plan is active. From half
 * the free credits used it also names the chat the user is on and what the
 * credits left still pay for, and the plan dialog waits beside checkout.
 */
export const UpgradePromo = () => {
  const { transport } = useAppContext();
  const host = usePromoHost();
  const snapshot = useRef<DOMRect | null>(null);
  const [target] = useState(() => {
    const element = document.createElement("div");
    element.dataset.slot = "promo-portal";
    return element;
  });
  const { t } = useTranslation();
  const prefs = usePrefs();
  const now = useNow();
  const preference = useMotionPreference();
  useLayoutEffect(() => {
    const previous = snapshot.current
      ? snapshot.current
      : (consumePromoRect() ?? snapshot.current);
    if (!host) {
      target.remove();
      return;
    }
    target.setAttribute("style", "pointer-events:none");
    host.element.appendChild(target);
    const next = target.firstElementChild?.getBoundingClientRect();
    const controls =
      previous && next && preference !== "reduced"
        ? animate(
            target,
            {
              x: [previous.left - next.left, 0],
              y: [previous.top - next.top, 0],
            },
            {
              ...springs.panel,
              onComplete: () => {
                snapshot.current =
                  target.firstElementChild?.getBoundingClientRect() ?? null;
              },
            }
          )
        : null;
    snapshot.current = next ?? null;
    return () => controls?.stop();
  }, [host, target, preference]);
  useEffect(() => () => target.remove(), [target]);
  const account = useCreditsAccount();
  const key = promoAccountKey(account.data);
  // Held: the counters read as the whole grant, but none of it can be spent.
  const held = freeCreditsHeld(account.data);
  useFreeCreditsVerifySurface(held && host != null);
  const state = held
    ? "held"
    : promoState(account.data, prefs.creditsExhaustedAt, now);
  const tier = creditsTier(account.data);
  const web = state === "web";
  const { chat } = useCurrentChat();
  const markKey = creditAccountKey(account.data);
  const verifyPhone = () => {
    startFreeCreditsWatch();
    void platformSystem(transport.client).openExternal({
      url: ABACUS_VERIFY_PHONE_URL,
    });
  };
  // A free account's card lists the plan's whole pitch, in the same order for
  // every account whether it uses bots or sessions; it waits for the plan (or
  // its failure) so the card does not grow once on screen.
  const pitching = state != null && !held && !web && tier === "free";
  const billing = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: pitching,
    staleTime: 60_000,
  });
  // From half the free credits used, the card speaks of the user's own work.
  const context = pitching
    ? creditsCardContext(
        account.data,
        markKey != null ? prefs.creditThresholds?.[markKey] : undefined,
        chat?.label.trim()
      )
    : null;
  if ((!held && tier !== "free" && !web) || !host)
    return createPortal(null, target);
  return createPortal(
    <AnimatePresence>
      {state && (!pitching || billing.status !== "pending") ? (
        <motion.aside
          key={key}
          data-slot="upgrade-promo"
          aria-label={t(
            held
              ? "creditsCard.lockedTitle"
              : web
                ? "creditsCard.paidWebTitle"
                : "creditsCard.upsellTitle"
          )}
          data-state={held ? "held" : undefined}
          data-level={context?.level}
          className={CREDITS_CARD_FRAME}
          initial={{
            opacity: 0,
            y: preference === "reduced" ? 0 : offsets.drill,
          }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: preference === "reduced" ? 0 : offsets.drill }}
          transition={
            preference === "reduced"
              ? reducedTransition
              : { duration: durations.crossFade / 1000, ease: easings.standard }
          }
        >
          <CreditsCardBody
            held={held}
            web={web}
            granted={account.data?.credits_granted ?? null}
            used={account.data?.credits_used ?? null}
            streakLeft={streakCreditsLeft(account.data?.streak, now)}
            routinesHeld={prefs.routineCreditHold != null}
            billing={pitching ? (billing.data ?? null) : null}
            context={context}
            onCta={() => {
              if (held) verifyPhone();
              else if (web)
                void platformSystem(transport.client).openExternal({
                  url: ABACUS_AGENT_URL,
                });
              // Inside the click: the web build opens its checkout tab here.
              else if (context != null)
                startPlanCheckout(
                  transport.client,
                  "credits_card",
                  String(context.level)
                );
              else void openUpgrade(transport.client, "credits_card");
            }}
          />
        </motion.aside>
      ) : null}
    </AnimatePresence>,
    target
  );
};

/** The card's frame, shared by the sidebar and the gallery. */
export const CREDITS_CARD_FRAME =
  "bg-background pointer-events-auto relative isolate w-full overflow-hidden rounded-(--pane-radius) border p-3";

export interface CreditsCardBodyProps {
  /** The free credits are held until the phone is verified. */
  held: boolean;
  /** A paid plan: the card points at AbacusAI Agent on the web. */
  web: boolean;
  granted: number | null;
  used: number | null;
  streakLeft: number;
  routinesHeld: boolean;
  /** The free plan's pitch, once read; null for any other card. */
  billing: BillingPlan | null;
  /** The free plan's own work, from half its credits used (credits-card-context.ts). */
  context: CreditsCardContext | null;
  onCta(): void;
}

/** What the card holds inside its frame: the sidebar's and the gallery's. */
export const CreditsCardBody = ({
  held,
  web,
  granted,
  used,
  streakLeft,
  routinesHeld,
  billing,
  context,
  onCta,
}: CreditsCardBodyProps) => {
  const { t, i18n } = useTranslation();
  const preference = useMotionPreference();
  const [excited, setExcited] = useState(false);
  const remaining =
    granted != null && used != null ? Math.max(0, granted - used) : null;
  const whole = (value: number) =>
    new Intl.NumberFormat(i18n.language).format(Math.max(0, Math.round(value)));
  const title = held
    ? t("creditsCard.lockedTitle")
    : web
      ? t("creditsCard.paidWebTitle")
      : context != null
        ? levelTitle(t, context.level, whole(remaining ?? 0))
        : t(
            remaining === 0
              ? "creditsCard.outTitle"
              : remaining != null &&
                  granted != null &&
                  granted > 0 &&
                  remaining / granted < LOW_CREDITS_SHARE
                ? "creditsCard.lowTitle"
                : "creditsCard.levelUpTitle"
          );
  const lines = web ? WEB_LINES : [];
  const offer = wallOffer(billing);
  const level = context != null ? String(context.level) : undefined;
  return (
    <>
      <div className="phone-glow pointer-events-none -z-10" aria-hidden />
      <div className="flex items-center gap-3">
        <PromoCharacter
          remaining={held ? null : remaining}
          total={granted}
          excited={excited}
          upgraded={false}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {lines.length > 0 && (
            <ul className="text-muted-foreground mt-0.5 flex flex-col gap-0.5 text-xs">
              {lines.map(({ key, icon: Icon }) => (
                <li key={key} className="flex gap-1.5">
                  <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          )}
          {!held && !web && routinesHeld && (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("creditsCard.routinesHeld")}
            </p>
          )}
          {held ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("creditsCard.lockedBody")}
            </p>
          ) : remaining != null ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("creditsCard.progress", {
                remaining: new Intl.NumberFormat(i18n.language, {
                  maximumFractionDigits: 2,
                }).format(remaining),
                total: new Intl.NumberFormat(i18n.language, {
                  maximumFractionDigits: 2,
                }).format(granted ?? 0),
              })}
            </p>
          ) : null}
          {!held && streakLeft > 0 ? (
            <p
              data-slot="streak-credits-line"
              className="mt-1 flex items-center gap-1 text-xs font-medium text-orange-700 dark:text-orange-300"
            >
              <StreakFlame className="size-3.5" />
              {t("streak.sidebarLine", {
                credits: new Intl.NumberFormat(i18n.language).format(
                  streakLeft
                ),
              })}
            </p>
          ) : null}
          {!held && granted != null && granted > 0 && remaining != null ? (
            <div
              role="progressbar"
              aria-label={t("creditsCard.used")}
              aria-valuemin={0}
              aria-valuemax={granted}
              aria-valuenow={Math.min(granted, Math.max(0, used ?? 0))}
              className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
            >
              <motion.div
                className="bg-primary h-full origin-left rounded-full"
                initial={false}
                animate={{
                  scaleX: Math.min(1, Math.max(0, (used ?? 0) / granted)),
                }}
                transition={
                  preference === "reduced" ? reducedTransition : springs.panel
                }
              />
            </div>
          ) : null}
        </div>
      </div>
      {context != null &&
      (context.project != null ||
        (context.estimate != null && context.level !== 100)) ? (
        <ul
          data-slot="credits-card-context"
          className="bg-muted/60 mt-3 flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-xs/4"
        >
          {context.project != null && (
            <li className="flex gap-2">
              <MessageSquareText
                aria-hidden
                className="text-muted-foreground mt-px size-3.5 shrink-0"
              />
              <span className="min-w-0 break-words">
                {t("creditsCard.context.project", {
                  project: context.project,
                })}
              </span>
            </li>
          )}
          {context.estimate != null && context.level !== 100 && (
            <li className="flex gap-2">
              <Gauge
                aria-hidden
                className="text-muted-foreground mt-px size-3.5 shrink-0"
              />
              <span>
                {t(estimateKey(context.level, context.estimate.kind), {
                  count: context.estimate.count,
                })}
              </span>
            </li>
          )}
        </ul>
      ) : null}
      {billing != null ? (
        <div className="mt-3 flex min-h-0 flex-col gap-1.5">
          {offer != null && (
            <p className="text-muted-foreground text-xs font-medium">
              {t("upgradeDialog.planTitle", { plan: offer.planName })}
              {context != null && (
                <span
                  data-slot="credits-card-price"
                  className="text-foreground block font-semibold"
                >
                  {planPrice(t, offer, i18n.language)}
                </span>
              )}
            </p>
          )}
          {/* Whole from an 800px window up, three sessions still above it; shorter, it scrolls in place. */}
          <div className="scroll-fade-y max-h-[clamp(5rem,calc(100vh_-_28rem),24rem)] overflow-y-auto overscroll-contain">
            <PlanPitchList
              billing={billing}
              sameForEveryone
              className="gap-1.5 [&_li]:gap-2 [&_li]:text-xs/4 [&_svg]:mt-px [&_svg]:size-3.5"
            />
          </div>
        </div>
      ) : null}
      <Button
        size="sm"
        className="mt-3 h-8 rounded-lg"
        onMouseEnter={() => setExcited(true)}
        onMouseLeave={() => setExcited(false)}
        onFocus={() => setExcited(true)}
        onBlur={() => setExcited(false)}
        data-action={held ? "verify-phone" : undefined}
        onClick={onCta}
      >
        {held ? (
          t("outcome.verifyPhone.cta")
        ) : web ? (
          <>
            {t("creditsCard.paidWebCta")}
            <ArrowUpRight aria-hidden />
          </>
        ) : (
          <>
            <UpgradeSeen src="credits_card" {...(level != null && { level })} />
            <Sparkles aria-hidden />
            {context != null ? upgradeCtaLabel(t, offer) : t("creditsCard.cta")}
          </>
        )}
      </Button>
    </>
  );
};

/** The milestone card's own title for the level, so both say the same. */
const levelTitle = (
  t: (key: string, values?: Record<string, string>) => string,
  level: CreditsCardLevel,
  left: string
): string =>
  level === 100
    ? t("creditsCard.outTitle")
    : t(CREDIT_THRESHOLD_COPY[level].title, { left });
