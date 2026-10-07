import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { ABACUS_PLAN_URL, creditMarkState } from "#renderer/lib/credits";
import {
  durations,
  easings,
  offsets,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

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
    right: 24,
    bottom: 24,
    maxWidth: 320,
  });
  useLayoutEffect(() => {
    if (!state) return;
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
      const fitsBelow =
        !composerRect ||
        (rect?.bottom ?? window.innerHeight) - composerRect.bottom >=
          promoHeight + 24;
      const fitsAbove =
        !composerRect ||
        composerRect.top - (rect?.top ?? 0) >= promoHeight + 32;
      setPosition({
        visibility: fitsBelow || fitsAbove ? "visible" : "hidden",
        right: Math.max(
          16,
          window.innerWidth - (rect?.right ?? window.innerWidth) + 16
        ),
        bottom:
          composerRect && !fitsBelow
            ? window.innerHeight - composerRect.top + 16
            : 24,
        maxWidth: Math.min(
          320,
          Math.max(200, (rect?.width ?? window.innerWidth) - 32)
        ),
      });
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
  }, [state, location.href]);
  const remaining =
    account.data?.credits_granted != null && account.data.credits_used != null
      ? Math.max(0, account.data.credits_granted - account.data.credits_used)
      : null;
  return (
    <AnimatePresence>
      {state ? (
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
                situation: state,
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
          <p className="pr-6 text-sm font-semibold">
            {t("creditsCard.upsellTitle")}
          </p>
          {remaining != null ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("creditsCard.remaining", { count: remaining })}
            </p>
          ) : null}
          <Button
            size="sm"
            className="mt-3 h-8 rounded-lg"
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
