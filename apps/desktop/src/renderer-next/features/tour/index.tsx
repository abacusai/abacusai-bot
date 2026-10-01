import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spotlight, waitForAnchor } from "#next/components/spotlight";
import type { Box } from "#next/components/spotlight/geometry";
import { useDb } from "#next/data/db";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Badge } from "#next/ui/badge";
import { Button } from "#next/ui/button";

import { completeTour } from "./completion";
import { TOUR_STOPS } from "./stops";
import { startTour, tourStore, useTourState } from "./store";
/** @public Phase-5 sign-out integration. */
export { tourSignedOut } from "./store";
export { startTour, useTourState } from "./store";
export const TourHost = () => {
  const router = useRouter();
  const { transport } = router.options.context;
  const db = useDb();
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const active = useTourState();
  const [rect, setRect] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    ...transport.orpc.notch.status.queryOptions({ input: {} }),
    enabled: active !== null,
  });
  const stops = TOUR_STOPS.filter(
    (stop) => stop.id !== "notch" || status.data?.available
  );
  const stop = active
    ? stops[Math.min(active.stopIndex, stops.length - 1)]
    : null;
  const end = (result: "done" | "skipped") =>
    completeTour(result, {
      persist: (status) => db.updatePrefs({ tour: { status, at: Date.now() } }),
      telemetry: (status) =>
        transport.client.system.funnelStep({
          step: status === "done" ? "tour_done" : "tour_skipped",
        }),
      navigate: (href) => navigate({ href }),
    });
  const dismiss = () => {
    void end("skipped");
  };
  useEffect(() => {
    if (!stop) return;
    const abort = new AbortController();
    let observer: ResizeObserver | null = null;
    const measure = (element: HTMLElement | null) => {
      const r = element?.isConnected ? element.getBoundingClientRect() : null;
      setRect(
        r && r.width && r.height
          ? { x: r.x, y: r.y, width: r.width, height: r.height }
          : null
      );
    };
    let element: HTMLElement | null = null;
    const refresh = () => measure(element);
    const prepare = async () => {
      setBusy(true);
      setRect(null);
      try {
        let href = stop.href;
        if (stop.id === "talk") {
          const bot = db.collections.bots.toArray.at(-1);
          href = bot ? `/bots/${encodeURIComponent(bot.id)}` : "/sessions/new";
        }
        if (stop.id === "changes" || stop.id === "preview-terminal") {
          const session = db.collections.sessions.toArray.find(
            (s) => s.owner == null && s.routineId == null
          );
          if (session)
            href = `/sessions/${encodeURIComponent(session.id)}?tab=${stop.id === "changes" ? "changes" : "terminal"}`;
        }
        if (href) await navigate({ href });
        if (abort.signal.aborted) return;
        if (stop.id === "notch") await transport.client.notch.preview({});
        element = stop.anchor
          ? await waitForAnchor(stop.anchor, 2000, abort.signal)
          : null;
        if (abort.signal.aborted) return;
        element?.scrollIntoView?.({ block: "nearest" });
        measure(element);
        observer = new ResizeObserver(refresh);
        if (element) observer.observe(element);
        window.addEventListener("resize", refresh);
        window.addEventListener("scroll", refresh, true);
      } catch (error) {
        if (!abort.signal.aborted) setBusy(false);
        throw error;
      }
      if (!abort.signal.aborted) setBusy(false);
    };
    void prepare().catch(() => {
      if (!abort.signal.aborted) setBusy(false);
    });
    return () => {
      abort.abort();
      observer?.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [stop, db, transport, navigate]);
  if (!active || !stop) return null;
  const move = (delta: number) =>
    tourStore.setState((state) => ({
      active: state.active
        ? {
            ...state.active,
            stopIndex: Math.max(0, state.active.stopIndex + delta),
          }
        : null,
    }));
  return (
    <Spotlight
      rect={rect}
      onDismiss={dismiss}
      busy={busy}
      titleId="tour-title"
      bodyId="tour-body"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="tour-title" className="font-semibold">
          {t(`tour.stops.${stop.id}.title`)}
        </h2>
        <span className="text-muted-foreground text-xs">
          {t("tour.progress", {
            current: active.stopIndex + 1,
            total: stops.length,
          })}
        </span>
      </div>
      <p id="tour-body" className="my-4 text-sm">
        {t(`tour.stops.${stop.id}.body`, { n: stops.length })}
      </p>
      {stop.optional && <Badge variant="secondary">{t("tour.optional")}</Badge>}
      <div className="mt-4 flex gap-2">
        <Button variant="ghost" disabled={busy} onClick={dismiss}>
          {t("tour.skip")}
        </Button>
        <div className="flex-1" />
        {active.stopIndex > 0 && (
          <Button variant="secondary" disabled={busy} onClick={() => move(-1)}>
            {t("common.back")}
          </Button>
        )}
        <Button
          data-tour-next
          disabled={busy}
          onClick={() =>
            active.stopIndex === stops.length - 1 ? void end("done") : move(1)
          }
        >
          {t(
            active.stopIndex === stops.length - 1 ? "tour.finish" : "tour.next"
          )}
        </Button>
      </div>
    </Spotlight>
  );
};

/** @public Settings/command-menu replay, available only after account completion. */
export const useStartTour = () => {
  const router = useRouter();
  const { transport } = router.options.context;
  const account = useQuery(
    transport.orpc.account.state.queryOptions({ input: {} })
  );
  return () =>
    startTour({
      origin: router.state.location.href,
      onboarded: account.data?.onboarded === true,
    });
};

export { TourGallery } from "./gallery";
