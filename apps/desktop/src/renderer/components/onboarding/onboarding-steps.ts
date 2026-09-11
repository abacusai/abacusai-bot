/**
 * Which screens a first run is made of, and in what order. One sequence for
 * everybody, minus auth for someone already signed in and minus the models
 * screen for a subscriber whose plan already covers them.
 */
export type OnboardingStep =
  | "auth"
  | "welcome"
  | "explainer"
  | "connectors"
  | "models";

export interface OnboardingRoute {
  /** Does the app already hold an Abacus.AI credential? */
  signedIn: boolean;
  /** A paying tier (Basic/Go/Pro/Max)? Their plan already covers the models. */
  paying: boolean;
  /**
   * Has this profile been through first-run before? Someone who signed out is
   * still onboarded: they need the sign-in wall back, not the whole tour.
   */
  onboarded?: boolean;
}

export const stepsFor = ({
  signedIn,
  paying,
  onboarded = false,
}: OnboardingRoute): OnboardingStep[] =>
  // A returning user with no credential: the wall, and nothing behind it.
  // Signing out keeps `onboarded`, so without this the second sign-in of an
  // account's life replayed the welcome, the connectors, the models and the
  // tour — a first run for someone who had already had one.
  onboarded
    ? signedIn
      ? []
      : ["auth"]
    : [
        ...(signedIn ? [] : (["auth"] as const)),
        "welcome",
        "connectors",
        // Free tier only: a paying plan covers the catalog and RouteLLM arrives
        // preselected, so the screen would be a detour.
        ...(paying ? [] : (["models"] as const)),
        // Last, and unconditional: the tour spotlights the real workspace, and the
        // flow guarantees one exists via `ensureDefaultWorkspace` (an empty folder
        // of the app's own, never the user's home directory).
        "explainer",
      ];

/** The next screen, or null at the end of the flow. */
export const nextStep = (
  steps: OnboardingStep[],
  current: OnboardingStep
): OnboardingStep | null => steps[steps.indexOf(current) + 1] ?? null;

/** The previous screen, or null at the first one. */
export const previousStep = (
  steps: OnboardingStep[],
  current: OnboardingStep
): OnboardingStep | null => {
  const index = steps.indexOf(current);
  return index > 0 ? (steps[index - 1] ?? null) : null;
};

/** How far along to draw the dots: position of `current`, and how many there are. */
export const stepProgress = (
  steps: OnboardingStep[],
  current: OnboardingStep
): { index: number; total: number } => ({
  index: Math.max(0, steps.indexOf(current)),
  total: steps.length,
});
