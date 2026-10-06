/**
 * The frame (spec 06 §7.1, canvas page 11): the full-window wash, the
 * progress pill in the title bar's drag strip (five marks; `connect` and
 * `connected` share mark 2, `first-bot` and `done` mark 5), the avatar stage
 * and the centred column. It is the `/onboarding` layout's component, so it
 * (and the stage's avatars) stay mounted while the step routes swap
 * underneath.
 */
import { useSelector } from "@tanstack/react-store";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useMotionPreference } from "#renderer/lib/motion";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { firstBotStore, type FirstBotResult } from "./first-bot";
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
    <div className="onboarding-frame" data-reduced-motion={reduce}>
      <OnboardingProgress step={step} />
      <div id="onboarding-consent" className="shrink-0 px-6" />
      <div className="onboarding-column">
        <OnboardingStage step={step} bot={bot} phase={phase} reduced={reduce} />
        {children}
      </div>
    </div>
  );
};
