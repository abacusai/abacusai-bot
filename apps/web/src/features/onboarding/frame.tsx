import { useSelector } from "@tanstack/react-store";
import { ChevronLeft, Volume2, VolumeX } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { BotAppMark } from "#renderer/components/app-icon";
import { useOptionalDb } from "#renderer/data/db";
import { springs, useMotionPreference } from "#renderer/lib/motion";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { Button } from "#renderer/ui/button";

import { firstBotStore, type FirstBotResult } from "./first-bot";
import { useOnboardingSound } from "./sound";
import { OnboardingStage, type FirstBotPhase } from "./stage";

export const PROGRESS_MARK: Record<OnboardingStepId, number> = {
  welcome: 1,
  connect: 2,
  connected: 2,
  models: 3,
  connectors: 4,
  "first-bot": 5,
  done: 5,
};
export const stepDirection = (from: OnboardingStepId, to: OnboardingStepId) =>
  ONBOARDING_STEPS.indexOf(to) < ONBOARDING_STEPS.indexOf(from)
    ? "back"
    : "forward";
const MARKS = [1, 2, 3, 4, 5] as const;

export const OnboardingProgress = ({ step }: { step: OnboardingStepId }) => {
  const { t } = useTranslation();
  const mark = PROGRESS_MARK[step];
  return (
    <div
      className="onboarding-progress titlebar-drag"
      role="progressbar"
      aria-label={t("onboarding.frame.progress", { n: mark })}
      aria-valuemin={1}
      aria-valuemax={5}
      aria-valuenow={mark}
      aria-valuetext={t("onboarding.frame.progress", { n: mark })}
    >
      {MARKS.map((n) => (
        <span key={n} data-current={n === mark} data-done={n < mark} />
      ))}
    </div>
  );
};

export const OnboardingFrame = ({
  step,
  previewBot,
  children,
}: {
  step: OnboardingStepId;
  /** The gallery's first bot (the live flow reads `firstBotStore`). */
  previewBot?: FirstBotResult;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const [transition, setTransition] = useState({
    step,
    direction: "forward" as "forward" | "back",
  });
  if (transition.step !== step)
    setTransition({ step, direction: stepDirection(transition.step, step) });
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (frame.current) frame.current.scrollTop = 0;
  }, [step]);
  const sound = useOnboardingSound();
  const previousStep = useRef(step);
  const db = useOptionalDb();
  useEffect(() => {
    if (previousStep.current !== step)
      sound.play(
        step === "done" || step === "first-bot" ? "celebrate" : "step"
      );
    previousStep.current = step;
  }, [step, sound]);
  const reduce = useMotionPreference() === "reduced";
  const live = useSelector(firstBotStore, (s) => s);
  const first = previewBot
    ? { state: "ready" as const, result: previewBot }
    : live;
  const bot = first.state === "ready" ? first.result.bot : null;
  const phase: FirstBotPhase =
    first.state === "ready"
      ? "ready"
      : first.state === "pending" || first.state === "idle"
        ? "pending"
        : "none";
  return (
    <div ref={frame} className="onboarding-frame" data-reduced-motion={reduce}>
      {step !== "first-bot" && step !== "done" && (
        <OnboardingProgress step={step} />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="titlebar-nodrag absolute top-12 right-4 z-30"
        aria-label={t(
          sound.enabled ? "onboarding.soundOn" : "onboarding.soundOff"
        )}
        aria-pressed={sound.enabled}
        onClick={sound.toggle}
      >
        {sound.enabled ? <Volume2 /> : <VolumeX />}
      </Button>
      <div id="onboarding-consent" className="shrink-0 px-6" />
      <LayoutGroup id="onboarding">
        <div
          className="onboarding-column"
          data-step-direction={transition.direction}
        >
          <motion.div
            layout
            initial={false}
            transition={reduce ? { duration: 0 } : springs.surface}
            className="onboarding-brand titlebar-drag"
            data-slot="onboarding-brand"
            data-welcome={step === "welcome"}
          >
            <BotAppMark size={step === "welcome" ? 32 : 18} />
            <span>{t("shell.appName")}</span>
          </motion.div>
          <OnboardingStage
            step={step}
            bot={bot}
            phase={phase}
            reduced={reduce}
            cast={db?.collections.bots.toArray
              .filter((item) => item.channel == null && item.id !== bot?.id)
              .slice(0, 3)}
            onPoke={() => sound.play("pop")}
          />
          <motion.div
            key={step}
            className="w-full"
            data-slot="onboarding-content"
            data-direction={transition.direction}
            initial={{
              opacity: 0,
              x: reduce ? 0 : transition.direction === "back" ? -12 : 12,
            }}
            animate={{ opacity: 1, x: 0 }}
            transition={reduce ? { duration: 0.12 } : springs.surface}
          >
            {children}
          </motion.div>
        </div>
      </LayoutGroup>
    </div>
  );
};

/** Keep window navigation outside the animated step content. */
export const OnboardingNavigation = ({ onBack }: { onBack?: () => void }) => {
  const { t } = useTranslation();
  return createPortal(
    <div
      className="onboarding-navigation titlebar-drag"
      data-slot="onboarding-navigation"
    >
      {onBack && <span className="onboarding-brand-space" aria-hidden />}
      {onBack && (
        <Button
          variant="ghost"
          className="titlebar-nodrag text-muted-foreground shrink-0 gap-1"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden className="size-3.5" />
          {t("common.back")}
        </Button>
      )}
    </div>,
    document.body
  );
};
