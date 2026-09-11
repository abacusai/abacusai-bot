import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  MessageSquare,
  Plug,
  Shapes,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
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
import { useWorkspaceStore } from "../../stores/code-store";
import { useTourStore } from "../../stores/tour-store";
import { Button } from "../ui";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";

const TOUR_ID = "workspace-onboarding";
/** The bot maker's name field: the second stop's subject. */
const BOT_MAKER_TARGET = '[data-id="bots-home-name-input"]';
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

/**
 * What each stop looks like, in step order. A parallel array: Tourlight owns
 * the step shape and only carries a title and a body.
 */
const TOUR_STOPS: {
  icon: LucideIcon;
  optional?: boolean;
  subtitleKey?: string;
  /** Rows, when a stop covers two things rather than describing one. */
  bullets?: { icon: LucideIcon; bodyKey: string }[];
}[] = [
  {
    icon: Bot,
    bullets: [
      { icon: Bot, bodyKey: "tour.steps.bots.bulletBots" },
      { icon: MessageSquare, bodyKey: "tour.steps.bots.bulletSessions" },
    ],
  },
  { icon: MessageSquare },
  { icon: Plug },
  {
    icon: SquareTerminal,
    optional: true,
    subtitleKey: "tour.steps.terminal.audience",
  },
];

export const TourTooltip = ({
  step,
  next,
  previous,
  skip,
  currentIndex,
  totalSteps,
}: TooltipRenderProps): JSX.Element => {
  const { t } = useTranslation();
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalSteps - 1;
  const stop = TOUR_STOPS[currentIndex] ?? { icon: Shapes };
  const Icon = stop.icon;

  return (
    <Card
      className="bg-card/85 w-[min(26rem,calc(100vw-2rem))] gap-5 rounded-2xl p-6 shadow-2xl backdrop-blur-2xl"
      data-id="welcome-tour-card"
      role="dialog"
      aria-modal="true"
    >
      <CardHeader className="grid-cols-[1fr_auto] items-start gap-3 p-0">
        {/* The badge sits above the title rather than beside it: at this size
            a glyph on the title's baseline competes with it for the eye. */}
        <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
          <Icon className="size-6" />
        </span>
        <CardAction className="col-start-2 row-start-1 self-start">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={skip}
            data-id="welcome-tour-close"
            aria-label={t("tour.skip")}
          >
            <X />
          </Button>
        </CardAction>
        <div className="col-span-2 flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <CardTitle
              data-id="welcome-tour-title"
              className="text-2xl font-bold tracking-tight"
            >
              {step.title}
            </CardTitle>
            {stop.optional === true && (
              <span
                className="bg-primary/10 text-primary rounded-full px-2.5 py-0.5 text-xs font-semibold"
                data-id="welcome-tour-optional"
              >
                {t("tour.optional")}
              </span>
            )}
          </div>
          {stop.subtitleKey != null && (
            <p
              className="text-muted-foreground text-sm"
              data-id="welcome-tour-subtitle"
            >
              {t(stop.subtitleKey)}
            </p>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-0">
        {stop.bullets == null ? (
          <p className="text-foreground/80 text-[15px] leading-relaxed">
            {step.content}
          </p>
        ) : (
          <div className="flex flex-col gap-4" data-id="welcome-tour-bullets">
            {stop.bullets.map((bullet) => {
              const BulletIcon = bullet.icon;
              return (
                <div key={bullet.bodyKey} className="flex items-start gap-3.5">
                  <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
                    <BulletIcon className="size-5" />
                  </span>
                  <p className="text-foreground/80 pt-1.5 text-[15px] leading-relaxed">
                    {t(bullet.bodyKey)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={totalSteps}
          aria-valuenow={currentIndex + 1}
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: `${((currentIndex + 1) / totalSteps) * 100}%` }}
          />
        </div>
      </CardContent>

      <CardFooter className="justify-between gap-3 p-0">
        <span className="text-muted-foreground text-sm tabular-nums">
          {t("tour.progress", {
            current: currentIndex + 1,
            total: totalSteps,
          })}
        </span>
        <div className="flex items-center gap-2">
          {!isFirst && (
            <Button
              variant="outline"
              onClick={previous}
              data-id="welcome-tour-back"
              className="font-semibold"
            >
              <ArrowLeft />
              {t("common.back")}
            </Button>
          )}
          <Button
            onClick={next}
            data-id="welcome-tour-next"
            className="font-semibold"
          >
            {isLast ? t("tour.finish") : t("tour.next")}
            {!isLast && <ArrowRight />}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

/**
 * Wait until a selector has a box, not merely a node.
 *
 * Tourlight resolves a target with a MutationObserver, which fires the moment
 * the element is inserted — before the browser has laid it out — and measures
 * it with getBoundingClientRect() right there. A node inserted into a pane
 * that is still mounting measures 0x0 at the origin, and the spotlight draws
 * on the corner of the window. It is a race, so it hits the machine where the
 * pane takes a frame longer and nobody else.
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const waitForBox = async (
  selector: string,
  timeoutMs = 2_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const box = document
      .querySelector<HTMLElement>(selector)
      ?.getBoundingClientRect();
    if (box != null && box.width > 0 && box.height > 0) {
      // One more frame after it has a box: the pane is still settling around
      // it, and a rect measured on the frame it appears can still move.
      await nextFrame();
      return;
    }
    await nextFrame();
  }
};

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
  // Held in a ref so `leave` never changes identity: Tourlight registers the
  // tour in an effect keyed on its callbacks, and that effect's cleanup stops
  // a running tour, so an inline `onFinish` would tear the lap down a frame in.
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
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
  // Held in a ref for the same reason `leave` is: the steps memo must not
  // gain a dependency that changes, or registering them stops the tour.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const steps = useMemo<SpotlightStep[]>(() => {
    const stops: SpotlightStep[] = [
      {
        ...SPOTLIGHT_BOUNDS,
        // The bots tree, which is the whole sidebar.
        target: '[data-id="sidebar-lists"]',
        title: t("tour.steps.bots.title"),
        content: t("tour.steps.bots.body"),
        placement: "right",
        route: "/",
      },
      {
        ...SPOTLIGHT_BOUNDS,
        // The bot maker, put on screen by this step rather than hoped for.
        // The pane it would otherwise inherit can be a channel bot's chat,
        // which is read-only and renders neither a composer nor this field —
        // and a stop with no target dims the whole window and highlights
        // nothing, which is what the first users of the tour saw.
        target: BOT_MAKER_TARGET,
        title: t("tour.steps.makeBot.title"),
        content: t("tour.steps.makeBot.body"),
        placement: "top",
        // No `route` here on purpose. The provider navigates after
        // onBeforeStep and measures straight after that, so naming the route
        // meant a second navigation landing between the wait below and the
        // measure — remounting the pane and handing Tourlight a field with no
        // box again. The stop owns its navigation, and nothing follows it.
        // Navigating alone leaves the last session selected, and the pane
        // shows that instead of the maker.
        onBeforeStep: async () => {
          const store = useWorkspaceStore.getState();
          store.setNewPaneIntent("bot");
          if (store.activeWorkspaceId != null)
            store.setActiveSessionId(store.activeWorkspaceId, null);
          await navigateRef.current({ to: "/bots/new" });
          await waitForBox(BOT_MAKER_TARGET);
        },
      },
      {
        ...SPOTLIGHT_BOUNDS,
        target: '[data-id="sidebar-nav-connectors"]',
        title: t("tour.steps.connectors.title"),
        content: t("tour.steps.connectors.body"),
        placement: "right",
        route: "/",
      },
      {
        ...SPOTLIGHT_BOUNDS,
        // The toggle renders on the bots pane, where a shell scoped to the bot
        // folder is how the user sees which folder a bot runs in. The target
        // must exist, or the stop is skipped silently and still counted.
        target: '[data-id="local-code-bottom-panel-toggle"]',
        title: t("tour.steps.terminal.title"),
        content: t("tour.steps.terminal.body"),
        placement: "bottom",
        route: "/",
      },
    ];

    return stops.map((step, index, all) => ({
      ...step,
      // The tour left no trace in the logs, so "step 2 has an issue" could
      // only be read off a screen recording. A stop that logs its entrance
      // and not its arrival is one whose target never appeared.
      //
      // Inside the memo, not wrapped around it: SpotlightTour registers the
      // tour in an effect keyed on `steps` whose cleanup unregisters it, so
      // a fresh array each render stops the running tour — which is what a
      // wrapper here did, killing every lap at step 2, where the stop's own
      // navigation guarantees a re-render.
      onBeforeShow: () => {
        console.log(
          `[tour] step ${index + 1}/${all.length} → ${String(step.target)}`
        );
      },
      onAfterShow: () => {
        console.log(`[tour] step ${index + 1}/${all.length} shown`);
      },
    }));
  }, [t]);

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

  // Tourlight asks for this whenever a step names a route it is not on.
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
 * The tour outside the first run: the settings menu's replay. It renders a
 * tour someone asked for and never decides one is due (a cleared localStorage
 * must not look like a new user; see tour-store.ts), and stands down while the
 * onboarding overlay is up so two Tourlight instances never fight.
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
  const identityReady = accountLoaded && !abacusAccount.isPending;
  const ready = identityReady && !suppressed && onboarded;

  return isOpen && ready ? <WelcomeTour key={runId} /> : null;
};
