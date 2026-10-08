import "./tour.css";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useDb } from "#renderer/data/db";
import { showError } from "#renderer/lib/toast";

import { TourCard } from "./card";
import { completeTour } from "./completion";
import { TOUR_STOPS } from "./stops";
import { startTour, tourStore, useTourState } from "./store";
export { tourSignedOut, startTour, useTourState } from "./store";
export const TourHost = () => {
  const { transport } = useRouter().options.context;
  const db = useDb();
  const active = useTourState();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [closed, setClosed] = useState<number | null>(null);
  const ending = useRef<number | null>(null);
  const stop = active ? TOUR_STOPS[active.stopIndex] : null;
  useEffect(() => {
    const element =
      stop && closed !== active?.runId
        ? document.querySelector<HTMLElement>(
            `[data-tour-target="${stop.target}"]`
          )
        : null;
    const frame = requestAnimationFrame(() => setTarget(element));
    element?.setAttribute("data-tour-active", "");
    return () => {
      cancelAnimationFrame(frame);
      element?.removeAttribute("data-tour-active");
    };
  }, [stop, closed, active?.runId]);
  if (!active || !stop || closed === active.runId) return null;
  const end = (result: "done" | "skipped") => {
    if (ending.current === active.runId) return;
    ending.current = active.runId;
    setClosed(active.runId);
    void completeTour(result, {
      persist: (status) => db.updatePrefs({ tour: { status, at: Date.now() } }),
      telemetry: (status) =>
        transport.client.system.funnelStep({
          step: status === "done" ? "tour_done" : "tour_skipped",
        }),
      navigate: async () => {},
    }).catch((error: unknown) => {
      ending.current = null;
      setClosed(null);
      showError(error instanceof Error ? error.message : String(error));
    });
  };
  return target ? (
    <TourCard
      anchor={target}
      stop={stop}
      index={active.stopIndex}
      onDismiss={() => end("skipped")}
      onNext={() => {
        if (active.stopIndex === TOUR_STOPS.length - 1) end("done");
        else
          tourStore.setState((state) => ({
            active: state.active
              ? { ...state.active, stopIndex: state.active.stopIndex + 1 }
              : null,
          }));
      }}
    />
  ) : null;
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
      origin: router.state.location.publicHref,
      onboarded: account.data?.onboarded === true,
    });
};

export { TourGallery } from "./gallery";
