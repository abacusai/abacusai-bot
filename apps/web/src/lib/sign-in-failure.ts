import { COMMON_ORPC_ERROR_DEFS } from "@orpc/client";

// Retain only known protocol codes. Error messages, causes and payloads may
// contain credentials; never copy them into state, logs or rendered text.
export const safeAuthCode = (value: unknown): string =>
  typeof value === "string" && Object.hasOwn(COMMON_ORPC_ERROR_DEFS, value)
    ? value
    : "UNKNOWN";

export class SignInFailure extends Error {
  constructor(
    readonly stage: "auth-code" | "host-start" | "host-complete",
    readonly reason: "network" | "session" | "rejected",
    readonly code = "UNKNOWN"
  ) {
    super(`${stage}:${reason}:${safeAuthCode(code)}`);
  }
}

export const signInFailureCopy = (error: string) => {
  const [stage, reason, rawCode] = error.split(":");
  const code = safeAuthCode(rawCode);
  if (reason === "network")
    return { key: "onboarding.webSignIn.network", code };
  if (stage === "auth-code")
    return {
      key:
        reason === "session"
          ? "onboarding.webSignIn.session"
          : "onboarding.webSignIn.authCode",
      code,
    };
  if (stage === "host-start")
    return { key: "onboarding.webSignIn.hostStart", code };
  if (stage === "host-complete")
    return { key: "onboarding.webSignIn.hostComplete", code };
  return { key: "onboarding.frame.failed", code };
};
