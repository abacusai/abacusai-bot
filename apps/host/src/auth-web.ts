import { randomBytes, createHash } from "node:crypto";

import { ORPCError } from "@orpc/server";

import type { HostPlatformOperations, WebAuth } from "#main/handler";
import {
  abacusAppHost,
  abacusUserAgent,
} from "#main/services/providers/abacus-host";
import { readAccountState } from "#main/services/providers/account-service";

/** Browser sign-in: a single-use ten-minute S256 verifier kept on the host. */
export const createWebAuth: NonNullable<HostPlatformOperations["webAuth"]> = (
  adopt
): WebAuth => {
  let attempt: { verifier: string; expires: number } | undefined;
  return {
    start: async () => {
      const verifier = randomBytes(32).toString("base64url");
      attempt = { verifier, expires: Date.now() + 600_000 };
      return {
        challenge: createHash("sha256").update(verifier).digest("base64url"),
      };
    },
    complete: async ({ code }) => {
      const pending = attempt;
      attempt = undefined;
      if (!pending || pending.expires <= Date.now())
        throw new ORPCError("PRECONDITION_FAILED");
      const response = await fetch(
        `${abacusAppHost()}/api/v1/_exchangeAbacusaibotAuthCode`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": abacusUserAgent(),
          },
          body: JSON.stringify({
            authCode: code,
            verifier: pending.verifier,
            signinVariant: "web",
          }),
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (!response.ok) throw new ORPCError("UNAUTHORIZED");
      const body = (await response.json()) as {
        result?: { apiKey?: string };
        apiKey?: string;
      };
      const key = body.result?.apiKey ?? body.apiKey;
      if (!key) throw new ORPCError("UNAUTHORIZED");
      const adopted = await adopt(key, "web");
      if (!adopted.ok) throw new ORPCError("UNAUTHORIZED");
      return {
        ...readAccountState(),
        accountDetailsPending: adopted.accountDetailsPending === true,
      };
    },
  };
};
