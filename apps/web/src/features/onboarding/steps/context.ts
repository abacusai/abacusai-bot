import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { HomeChannel } from "@abacus-ai/contract/bots";
import type { AbacusAuthIntent } from "@abacus-ai/contract/contracts";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";

import type { Transport } from "#renderer/data/transport";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import type { OnboardingExit } from "../actions";
import type { FirstBotResult, FirstChoice, InboxPass } from "../first-bot";
import type { FlowFacts } from "../machine";

export interface OnboardingPageProps {
  preview?: boolean;
  previewBot?: FirstBotResult;
  /** The gallery's first-run screen: the inbox pass to show, or the choices. */
  previewFirstRun?: { inbox?: InboxPass; chatApp?: HomeChannel };
  step: OnboardingStepId;
  transport: Transport;
  facts: FlowFacts;
  navigate(step: OnboardingStepId): Promise<void>;
  signIn(intent: AbacusAuthIntent): void;
  cancelSignIn(): Promise<void>;
  /** `tour`: start the tour once the destination is open. */
  complete(exit: OnboardingExit, options?: { tour?: boolean }): Promise<void>;
  /** The Chief of Staff after a Gmail sign-in, else null: the choices show. */
  createFirstBot(id: string): Promise<FirstBotResult | null>;
  choose(choice: FirstChoice): Promise<void>;
  connect?(id: string): Promise<unknown>;
  /** The plan's whole pitch for the offer step, composed by the route (the upgrade dialog's list). */
  planPitch?(billing: BillingPlan | null): ReactNode;
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
