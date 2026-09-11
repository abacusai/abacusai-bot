import { toast } from "sonner";

import i18n from "../i18n";

/**
 * Sign in to Abacus.AI and toast on success, from this one place: the sign-in
 * completes in the browser, so the user returns not knowing whether anything
 * happened, and a confirmation only some call sites show is worse than none.
 * Failure and cancellation are each caller's business; a cancel is not an
 * error.
 */
export const signInToAbacus = async (): Promise<
  Awaited<ReturnType<typeof window.api.agent.startAbacusAuth>>
> => {
  const result = await window.api.agent.startAbacusAuth();

  if (result.ok === true) {
    toast.success(i18n.t("onboarding.abacusConnected"));

    return result;
  }

  // Main refuses a key it cannot attribute to an account (it would land in
  // whichever profile is active) and reports a code; the sentence lives here,
  // where there is a translator.
  if (result.error === "unidentified-account") {
    return { ...result, error: i18n.t("onboarding.abacusUnidentified") };
  }

  return result;
};
