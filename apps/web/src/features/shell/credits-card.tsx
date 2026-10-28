import { wallOffer } from "@abacus-ai/contract/billing-plan";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  FileText,
  Globe,
  ImageIcon,
  Sparkles,
} from "lucide-react";
import { AnimatePresence, motion, animate } from "motion/react";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

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
import { useAppContext } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import { PlanPitchList } from "../upgrade-dialog/plan-pitch";
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
 * repeating it; the account is watched until the plan is active.
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
  const { t, i18n } = useTranslation();
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
  const [excited, setExcited] = useState(false);
  const tier = creditsTier(account.data);
  const remaining =
    account.data?.credits_granted != null && account.data.credits_used != null
      ? Math.max(0, account.data.credits_granted - account.data.credits_used)
      : null;
  const granted = account.data?.credits_granted ?? null;
  const title =
    remaining === 0
      ? "creditsCard.outTitle"
      : remaining != null &&
          granted != null &&
          granted > 0 &&
          remaining / granted < LOW_CREDITS_SHARE
        ? "creditsCard.lowTitle"
        : "creditsCard.levelUpTitle";
  const web = state === "web";
  const verifyPhone = () => {
    startFreeCreditsWatch();
    void platformSystem(transport.client).openExternal({
      url: ABACUS_VERIFY_PHONE_URL,
    });
  };
  const lines = web ? WEB_LINES : [];
  // A free account's card lists the plan's whole pitch, in the same order for
  // every account whether it uses bots or sessions; it waits for the plan (or
  // its failure) so the card does not grow once on screen.
  const pitching = state != null && !held && !web && tier === "free";
  const billing = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: pitching,
    staleTime: 60_000,
  });
  const offer = wallOffer(billing.data ?? null);
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
          className="bg-background pointer-events-auto relative isolate w-full overflow-hidden rounded-(--pane-radius) border p-3"
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
          <div className="phone-glow pointer-events-none -z-10" aria-hidden />
          <div className="flex items-center gap-3">
            <PromoCharacter
              remaining={held ? null : remaining}
              total={account.data?.credits_granted ?? null}
              excited={excited}
              upgraded={false}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {t(
                  held
                    ? "creditsCard.lockedTitle"
                    : web
                      ? "creditsCard.paidWebTitle"
                      : title
                )}
              </p>
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
                    }).format(account.data?.credits_granted ?? 0),
                  })}
                </p>
              ) : null}
              {!held &&
              account.data?.credits_granted != null &&
              account.data.credits_granted > 0 &&
              remaining != null ? (
                <div
                  role="progressbar"
                  aria-label={t("creditsCard.used")}
                  aria-valuemin={0}
                  aria-valuemax={account.data.credits_granted}
                  aria-valuenow={Math.min(
                    account.data.credits_granted,
                    Math.max(0, account.data.credits_used ?? 0)
                  )}
                  className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                >
                  <motion.div
                    className="bg-primary h-full origin-left rounded-full"
                    initial={false}
                    animate={{
                      scaleX: Math.min(
                        1,
                        Math.max(
                          0,
                          (account.data.credits_used ?? 0) /
                            account.data.credits_granted
                        )
                      ),
                    }}
                    transition={
                      preference === "reduced"
                        ? reducedTransition
                        : springs.panel
                    }
                  />
                </div>
              ) : null}
            </div>
          </div>
          {pitching && billing.data != null ? (
            <div className="mt-3 flex min-h-0 flex-col gap-1.5">
              {offer != null && (
                <p className="text-muted-foreground text-xs font-medium">
                  {t("upgradeDialog.planTitle", { plan: offer.planName })}
                </p>
              )}
              {/* Whole from an 800px window up, three sessions still above it; shorter, it scrolls in place. */}
              <div className="scroll-fade-y max-h-[clamp(5rem,calc(100vh_-_28rem),24rem)] overflow-y-auto overscroll-contain">
                <PlanPitchList
                  billing={billing.data}
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
            onClick={() =>
              held
                ? verifyPhone()
                : void (web
                    ? platformSystem(transport.client).openExternal({
                        url: ABACUS_AGENT_URL,
                      })
                    : openUpgrade(transport.client))
            }
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
                <Sparkles aria-hidden />
                {t("creditsCard.cta")}
              </>
            )}
          </Button>
        </motion.aside>
      ) : null}
    </AnimatePresence>,
    target
  );
};
