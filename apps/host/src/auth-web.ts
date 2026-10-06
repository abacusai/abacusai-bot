import { randomBytes, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { ORPCError } from "@orpc/server";

import type {
  HostOperations,
  HostPlatformOperations,
  WebAuth,
} from "#main/handler";
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

const PROVISIONED_KEY = /^[A-Za-z0-9_]{16,128}$/;

/**
 * The server-side twin of the browser sign-in: a host nothing has signed in
 * (a phone user never opens it in a browser) gets its owner's bot key from
 * the server through its bootstrap, in an owner-only file. Adopted through
 * the same path a browser sign-in takes, then deleted; a host signed in
 * already only deletes it. True once there is nothing left to adopt.
 */
export const adoptProvisionedKey = async (
  file: string,
  signedIn: () => boolean,
  adopt: HostOperations["adoptAbacusCredential"],
  log: (line: string) => void = (line) => console.warn(line)
): Promise<boolean> => {
  let key: string;
  try {
    key = (await readFile(file, "utf8")).trim();
  } catch {
    return signedIn();
  }
  if (!signedIn()) {
    if (!PROVISIONED_KEY.test(key))
      log("[host] provisioned key unreadable; discarded");
    else if (!(await adopt(key, "web")).ok)
      log("[host] provisioned key refused; discarded");
  }
  await rm(file, { force: true });
  return signedIn();
};

/** At start, then while the host has no key: its bootstrap may provision one into a running host. */
export const followProvisionedKey = (
  file: string | undefined,
  signedIn: () => boolean,
  adopt: HostOperations["adoptAbacusCredential"],
  everyMs = 30_000
): (() => void) => {
  if (!file) return () => {};
  let timer: NodeJS.Timeout | undefined;
  const check = async () => {
    timer = undefined;
    if (await adoptProvisionedKey(file, signedIn, adopt)) return;
    timer = setTimeout(() => void check(), everyMs);
    timer.unref?.();
  };
  void check();
  return () => {
    if (timer) clearTimeout(timer);
  };
};
