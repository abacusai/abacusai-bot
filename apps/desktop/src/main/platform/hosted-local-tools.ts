/**
 * Hosted free accounts can't run local MCP servers (an entry with a command)
 * or the terminal. The plan comes from the server's account read; a plan that
 * can't be read is refused too. The desktop app is never limited here.
 */
import type { HostedLocalToolsRefusal } from "@abacus-ai/contract/contracts";
import { abacusPlanTier } from "@abacus-ai/contract/models";

import { fetchAbacusAccount } from "../services/providers/abacus";
import type { HostPlatform } from "./capabilities";

/** Null when local tools may run; otherwise why not. */
export const hostedLocalToolsRefusal = async (
  platform: HostPlatform
): Promise<HostedLocalToolsRefusal | null> => {
  if (platform !== "web-host") return null;
  const tier = abacusPlanTier(await fetchAbacusAccount());
  if (tier === "paid" || tier === "basic") return null;
  return tier === "free" ? "plan-required" : "plan-unreadable";
};
