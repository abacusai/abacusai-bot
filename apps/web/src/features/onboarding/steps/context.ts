import type { TFunction } from "i18next";
import type { ReactNode } from "react";

import type { Transport } from "#renderer/data/transport";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import type { OnboardingExit } from "../actions";
import type { FirstBotResult } from "../first-bot";
import type { FlowFacts } from "../machine";

export interface OnboardingPageProps {
  preview?: boolean;
  previewBot?: FirstBotResult;
  step: OnboardingStepId;
  transport: Transport;
  facts: FlowFacts;
  navigate(step: OnboardingStepId): Promise<void>;
  signIn(intent: "signup" | "signin", profileId?: string): void;
  cancelSignIn(): Promise<void>;
  complete(exit: OnboardingExit): Promise<void>;
  createFirstBot(id: string): Promise<FirstBotResult>;
  /** The platform's local-model row (Electron only). */
  localModel?: ReactNode;
  connect?(id: string): Promise<unknown>;
}

/** What every step body gets from the page. */
export interface StepContext {
  props: OnboardingPageProps;
  t: TFunction;
  busy: boolean;
  /** Runs one action at a time; a rejection shows the frame's error line. */
  perform(action: () => Promise<unknown>): Promise<void>;
  /** `next(step, { type: "next" })`. */
  advance(): void;
  /** `next(step, { type: "back" })`, or nothing where the flow has no back. */
  back(): void;
}
