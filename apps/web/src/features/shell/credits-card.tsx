import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import {
  ABACUS_PLAN_URL,
  creditMarkState,
  creditsTier,
} from "#renderer/lib/credits";
import {
  durations,
  easings,
  offsets,
  springs,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import { PromoCharacter } from "./promo-character";
import { promoPlacement } from "./promo-placement";
import {
  PROMO_DISMISS_MS,
  promoAccountKey,
  promoState,
  readPromoDismissal,
  type PromoDismissal,
} from "./promo-state";

/** Floating above the reading pane, clear of the composer and splitters. */
export const UpgradePromo = () => {
  const { transport } = useAppContext();
  const { t } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const now = useNow();
  const preference = useMotionPreference();
  const location = useLocation();
  const account = useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: { refresh: true } }),
    queryKey: [
      ...transport.orpc.account.abacus.queryKey({ input: { refresh: true } }),
      prefs.creditsExhaustedAt,
    ],
    staleTime: 60_000,
  });
  const key = promoAccountKey(account.data);
  const [dismissal, setDismissal] = useState<{
    key: string;
    value: PromoDismissal | null;
  } | null>(null);
  const state = promoState(
    account.data,
    prefs.creditsExhaustedAt,
    dismissal?.key === key ? dismissal.value : readPromoDismissal(key),
    now
  );
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    account.dataUpdatedAt >= (prefs.creditsExhaustedAt ?? Infinity)
  );
  useEffect(() => {
    if (mark === "clear")
      void update({ creditsExhaustedAt: null }).catch(() => {});
  }, [mark, update]);
  const [position, setPosition] = useState<CSSProperties>({
    left: 72,
    bottom: 24,
    maxWidth: 320,
  });
  const [excited, setExcited] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const tier = creditsTier(account.data);
  const previousTier = useRef(tier);
  useEffect(() => {
    const upgraded = previousTier.current === "free" && tier === "paid";
    previousTier.current = tier;
    if (!upgraded) return;
    setCelebrating(true);
    const timer = window.setTimeout(() => setCelebrating(false), 1800);
    return () => clearTimeout(timer);
  }, [tier]);
  useLayoutEffect(() => {
    if (!state && !celebrating) return;
    let frame = 0;
    const observer = new ResizeObserver(() => schedule());
    const observed = new Set<Element>();
    const measure = () => {
      const composer = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="composer"]'),
      ].find((element) => element.getBoundingClientRect().height > 0);
      const pane =
        composer?.closest<HTMLElement>('[data-dock-pane="chat"]') ??
        document.querySelector<HTMLElement>('[data-slot="pane"]');
      for (const element of [composer, pane]) {
        if (element && !observed.has(element)) {
          observed.add(element);
          observer.observe(element);
        }
      }
      const rect = pane?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const promoHeight =
        document
          .querySelector('[data-slot="upgrade-promo"]')
          ?.getBoundingClientRect().height || 128;
      const rail = document
        .querySelector('[data-slot="rail"]')
        ?.getBoundingClientRect();
      const sidebar = document
        .querySelector('[data-slot="sidebar-slot"]')
        ?.getBoundingClientRect();
      const footer = document
        .querySelector('[data-slot="sidebar-footer"]')
        ?.getBoundingClientRect();
      setPosition(
        promoPlacement({
          width: window.innerWidth,
          height: window.innerHeight,
          railRight: rail?.right ?? 56,
          sidebarRight: sidebar?.right ?? 56,
          paneTop: rect?.top ?? 40,
          cardHeight: promoHeight,
          composer: composerRect,
          footer,
          splitters: [
            ...document.querySelectorAll("[data-pane-gutter], .dv-sash"),
          ]
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0),
        })
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const shell = document.querySelector('[data-slot="shell"]');
    if (shell) observer.observe(shell);
    for (const element of document.querySelectorAll(
      '[data-slot="composer"], [data-slot="pane"], [data-slot="panel-workspace"]'
    ))
      observer.observe(element);
    const moves = new MutationObserver(schedule);
    if (shell) moves.observe(shell, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      moves.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
    };
  }, [state, celebrating, location.href]);
  const remaining =
    account.data?.credits_granted != null && account.data.credits_used != null
      ? Math.max(0, account.data.credits_granted - account.data.credits_used)
      : null;
  return (
    <AnimatePresence>
      {state || celebrating ? (
        <motion.aside
          key={`${key}:${state}`}
          data-slot="upgrade-promo"
          aria-label={t("creditsCard.upsellTitle")}
          className="bg-background fixed isolate z-30 w-80 overflow-hidden rounded-xl border p-3 shadow-lg"
          style={position}
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
          <Button
            size="icon-xs"
            variant="ghost"
            className="absolute top-1 right-1"
            aria-label={t("creditsCard.dismiss")}
            onClick={() => {
              const value: PromoDismissal = {
                until: now + PROMO_DISMISS_MS,
                situation: state ?? "upsell",
              };
              try {
                localStorage.setItem(key, JSON.stringify(value));
              } catch {
                /* Dismiss for this window. */
              }
              setDismissal({ key, value });
            }}
          >
            <X />
          </Button>
          <div className="flex items-center gap-3 pr-3">
            <PromoCharacter
              remaining={remaining}
              total={account.data?.credits_granted ?? null}
              excited={excited}
              upgraded={celebrating}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {t(
                  celebrating
                    ? "creditsCard.upgraded"
                    : remaining === 0
                      ? "creditsCard.restTitle"
                      : "creditsCard.levelUpTitle"
                )}
              </p>
              {remaining != null ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("creditsCard.progress", {
                    remaining,
                    total: account.data?.credits_granted ?? 0,
                  })}
                </p>
              ) : null}
              {account.data?.credits_granted != null &&
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
          <Button
            size="sm"
            className="mt-3 h-8 rounded-lg"
            onMouseEnter={() => setExcited(true)}
            onMouseLeave={() => setExcited(false)}
            onFocus={() => setExcited(true)}
            onBlur={() => setExcited(false)}
            disabled={celebrating}
            onClick={() =>
              void platformSystem(transport.client).openExternal({
                url: ABACUS_PLAN_URL,
              })
            }
          >
            <Sparkles aria-hidden />
            {t("creditsCard.cta")}
          </Button>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
};
