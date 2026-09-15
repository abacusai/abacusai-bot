/**
 * The first-run state chart: which screens a route is made of, in what order,
 * and where the flow stands once the facts behind the route change under it.
 */

/** Every screen, in the only order they ever appear. */
export const STEP_ORDER = [
  "auth",
  "welcome",
  "connectors",
  "models",
  "explainer",
] as const;

export type OnboardingStep = (typeof STEP_ORDER)[number];

export const isOnboardingStep = (value: unknown): value is OnboardingStep =>
  STEP_ORDER.includes(value as OnboardingStep);

export interface OnboardingRoute {
  /** Does the app already hold an Abacus.AI credential? */
  signedIn: boolean;
  /** A paying tier, whose plan already covers the models. */
  paying: boolean;
  /**
   * Has this profile been through first-run before? Signing out keeps this,
   * so a returning account gets the sign-in wall back and nothing behind it.
   */
  onboarded?: boolean;
}

/** The screens a given user is owed. */
export const stepsFor = ({
  signedIn,
  paying,
  onboarded = false,
}: OnboardingRoute): OnboardingStep[] => {
  if (onboarded) return signedIn ? [] : ["auth"];

  return [
    ...(signedIn ? [] : (["auth"] as const)),
    "welcome",
    "connectors",
    // A paying plan covers the catalog, so the screen would be a detour.
    ...(paying ? [] : (["models"] as const)),
    // Last: the tour spotlights the live window the earlier screens set up.
    "explainer",
  ];
};

/**
 * Where the flow stands after the route changed under `current`. No
 * credential means the wall, whatever was showing, since every later screen
 * assumes an account. A screen the route still has is kept; one it dropped
 * gives way to the next it does have. Null when nothing is left to show.
 */
export const settleStep = (
  steps: OnboardingStep[],
  current: OnboardingStep
): OnboardingStep | null => {
  if (steps.includes("auth")) return "auth";
  const from = STEP_ORDER.indexOf(current);

  return steps.find((step) => STEP_ORDER.indexOf(step) >= from) ?? null;
};

/** The next screen, or null at the end of the flow. */
export const nextStep = (
  steps: OnboardingStep[],
  current: OnboardingStep
): OnboardingStep | null => {
  const index = steps.indexOf(current);

  return index >= 0 ? (steps[index + 1] ?? null) : null;
};

/** The previous screen, or null at the first one. */
export const previousStep = (
  steps: OnboardingStep[],
  current: OnboardingStep
): OnboardingStep | null => {
  const index = steps.indexOf(current);

  return index > 0 ? (steps[index - 1] ?? null) : null;
};

/** Position of `current` in the route, and how many screens there are. */
export const stepProgress = (
  steps: OnboardingStep[],
  current: OnboardingStep
): { index: number; total: number } => ({
  index: Math.max(0, steps.indexOf(current)),
  total: steps.length,
});
