import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";

import "react-tourlight/styles.css";
import { useTranslation } from "react-i18next";
import {
  SpotlightProvider,
  SpotlightTour,
  lightTheme,
  useSpotlightControl,
  type SpotlightTheme,
  type SpotlightStep,
  type TooltipRenderProps,
} from "react-tourlight";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { defaultWorkspaceSearch } from "../../lib/route-search";
import { useAccountStore } from "../../stores/account-store";
import { useTourStore } from "../../stores/tour-store";
import { TOUR_ID, TOUR_STOPS } from "./tour-stops";
import { TourTooltip } from "./tour-tooltip";

/**
 * The guided tour over the live window, run by onboarding's last step and by
 * the settings menu's replay. Tourlight stops a running tour whenever the
 * steps array or a callback prop changes identity, so everything handed to
 * it below is memoised and caller callbacks are read through refs.
 */

const SPOTLIGHT_BOUNDS = {
  spotlightPadding: 3,
  spotlightRadius: 8,
} as const;

const TOUR_THEME: SpotlightTheme = {
  ...lightTheme,
  tooltip: {
    ...lightTheme.tooltip,
    background: "transparent",
    color: "var(--foreground)",
    borderRadius: "0",
    boxShadow: "none",
    padding: "0",
    maxWidth: "min(26rem, calc(100vw - 2rem))",
  },
  arrow: { fill: "var(--card)" },
};

/** Starts the lap once, however often Tourlight refreshes its control context. */
const TourStarter = (): null => {
  const { start } = useSpotlightControl();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;

    const frame = requestAnimationFrame(() => {
      startedRef.current = true;
      console.log("[tour] starting");
      start(TOUR_ID);
    });
    return () => cancelAnimationFrame(frame);
  }, [start]);

  return null;
};

const TourDefinition = ({
  onFinish,
}: {
  onFinish?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const close = useTourStore((state) => state.close);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Skip and finish land in the same place: a skipped lap must not leave the
  // user with the overlay gone and no onboarding step to answer.
  const leave = useCallback((): void => {
    console.log("[tour] over");
    close();
    onFinishRef.current?.();
  }, [close]);
  const renderTooltip = useCallback(
    (props: TooltipRenderProps) => <TourTooltip {...props} />,
    []
  );

  const steps = useMemo<SpotlightStep[]>(
    () =>
      TOUR_STOPS.map((stop, index) => ({
        ...SPOTLIGHT_BOUNDS,
        target: stop.target,
        placement: stop.placement,
        title: t(`tour.steps.${stop.key}.title`),
        content: t(`tour.steps.${stop.key}.body`),
        ...(stop.route == null ? {} : { route: stop.route }),
        ...(stop.prepare == null
          ? {}
          : { onBeforeStep: () => stop.prepare?.(navigateRef.current) }),
        // A stop that logs its entrance and not its arrival is one whose
        // target never appeared.
        onBeforeShow: () => {
          console.log(
            `[tour] step ${index + 1}/${TOUR_STOPS.length} → ${stop.target}`
          );
        },
        onAfterShow: () => {
          console.log(`[tour] step ${index + 1}/${TOUR_STOPS.length} shown`);
        },
      })),
    [t]
  );

  return (
    <>
      <SpotlightTour
        id={TOUR_ID}
        steps={steps}
        onComplete={leave}
        onSkip={leave}
        renderTooltip={renderTooltip}
      />
      <TourStarter />
    </>
  );
};

export const WelcomeTour = ({
  onFinish,
}: {
  /** Where to go when the tour ends, however it ends. */
  onFinish?: () => void;
} = {}): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // The lap ends on the workspace, not on whichever page the last stop left.
  useEffect(
    () => () => {
      void navigateRef.current({
        to: "/",
        search: defaultWorkspaceSearch,
        replace: true,
      });
    },
    []
  );

  const navigateTour = useCallback(
    (path: string): void => {
      void navigate(
        path === "/"
          ? { to: "/", search: defaultWorkspaceSearch }
          : { to: path }
      );
    },
    [navigate]
  );
  const isTourRouteActive = useCallback(
    (route: string): boolean => pathname === route,
    [pathname]
  );

  return (
    <SpotlightProvider
      theme={TOUR_THEME}
      overlayColor="color-mix(in oklab, var(--background) 72%, transparent)"
      transitionDuration={240}
      overlayClickToDismiss={false}
      showProgress={false}
      showSkip={false}
      waitForElementTimeout={2_000}
      labels={{
        next: t("tour.next"),
        previous: t("common.back"),
        skip: t("tour.skip"),
        done: t("tour.finish"),
        close: t("common.close"),
      }}
      navigate={navigateTour}
      isRouteActive={isTourRouteActive}
    >
      <TourDefinition onFinish={onFinish} />
    </SpotlightProvider>
  );
};

/**
 * The settings menu's replay. It renders a tour someone asked for and never
 * decides one is due (see tour-store.ts), and stands down while the
 * onboarding overlay owns the tour so two Tourlight instances never fight.
 */
export const WelcomeTourGate = ({
  suppressed = false,
}: {
  /** True while the onboarding flow is on screen and owns the tour. */
  suppressed?: boolean;
} = {}): JSX.Element | null => {
  const isOpen = useTourStore((state) => state.isOpen);
  const runId = useTourStore((state) => state.runId);
  const accountLoaded = useAccountStore((state) => state.loaded);
  const onboarded = useAccountStore((state) => state.onboarded);
  const abacusAccount = useAbacusAccountQuery();
  const ready =
    accountLoaded && !abacusAccount.isPending && !suppressed && onboarded;

  return isOpen && ready ? <WelcomeTour key={runId} /> : null;
};
