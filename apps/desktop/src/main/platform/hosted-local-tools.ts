/**
 * Hosted free accounts can't run local MCP servers (an entry with a command)
 * or the terminal. The plan comes from the server's account read; a plan that
 * can't be read is refused too. The desktop app is never limited here.
 */
import type { HostedLocalToolsRefusal } from "@abacus-ai/contract/contracts";
import { abacusPlanTier } from "@abacus-ai/contract/models";

import {
  abacusAccountAgeMs,
  fetchAbacusAccount,
} from "../services/providers/abacus";
import type { HostPlatform } from "./capabilities";

/** A failed read keeps the last good answer this long, then counts as unreadable. */
const HOSTED_PLAN_MAX_AGE_MS = 5 * 60_000;

const readTier = async (): Promise<string> => {
  try {
    const account = await fetchAbacusAccount();
    const age = abacusAccountAgeMs();
    if (age == null || age > HOSTED_PLAN_MAX_AGE_MS) return "unknown";
    return abacusPlanTier(account);
  } catch (error) {
    // Fail closed: a read that throws is a plan we can't read.
    console.warn("[hosted-local-tools] plan read failed:", error);
    return "unknown";
  }
};

/** Null when local tools may run; otherwise why not. */
export const hostedLocalToolsRefusal = async (
  platform: HostPlatform
): Promise<HostedLocalToolsRefusal | null> => {
  if (platform !== "web-host") return null;
  const tier = await readTier();
  if (tier === "paid" || tier === "basic") return null;
  return tier === "free" ? "plan-required" : "plan-unreadable";
};
