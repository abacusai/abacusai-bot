import type { AbacusAuthOutcome } from "@abacus-ai/contract/contracts";
import * as v from "valibot";

import type { Transport } from "#renderer/data/transport";
import {
  callApps,
  ConnectError,
} from "#renderer/features/shell/connect/services";
import { SignInFailure, safeAuthCode } from "#renderer/lib/sign-in-failure";

const failure = (stage: SignInFailure["stage"], error: unknown) => {
  const code = safeAuthCode(
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined
  );
  const network =
    (error instanceof ConnectError && error.network) ||
    error instanceof TypeError ||
    (stage !== "auth-code" && error instanceof Error && !("code" in error)) ||
    ["TIMEOUT", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT"].includes(code);
  return new SignInFailure(
    stage,
    network
      ? "network"
      : error instanceof ConnectError && error.kind === "signin"
        ? "session"
        : "rejected",
    code
  );
};
export const webSignIn = async (
  transport: Transport
): Promise<AbacusAuthOutcome> => {
  let challenge: string;
  try {
    ({ challenge } = await transport.client.auth.web.start({}));
  } catch (error) {
    throw failure("host-start", error);
  }
  let authCode: string;
  try {
    ({ authCode } = v.parse(
      v.object({ authCode: v.pipe(v.string(), v.minLength(1)) }),
      await callApps("createAbacusaibotAuthCode", { challenge })
    ));
  } catch (error) {
    throw failure("auth-code", error);
  }
  try {
    await transport.client.auth.web.complete({ code: authCode });
  } catch (error) {
    throw failure("host-complete", error);
  }
  return { ok: true };
};
