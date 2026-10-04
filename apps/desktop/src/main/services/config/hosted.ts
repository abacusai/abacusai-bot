/**
 * Running as the hosted web app's per-user server instead of the desktop app.
 * Unset (the desktop): every function here is inert. Set once at startup by
 * the web host (src/web-host/host.ts), before any agent spawns.
 *
 * The host runs many users' agents on machines we own, so what the desktop
 * leaves to the user's own Capabilities choices is fixed here instead: the
 * toolsets an agent may have, tools withheld even from those, and the
 * credentials it runs with, which come from the host's environment and are
 * never written to the user's config file.
 */
import { TOOLSETS, type ToolsetPreferences } from "#shared/toolsets";

export interface HostedPolicy {
  /** Toolset ids an agent may use; every other toolset is off. */
  toolsets: readonly string[];
  /** Tool names withheld even when their toolset is allowed. */
  excludedTools: readonly string[];
  /** Provider env var -> key, read in place of `config.json`'s `apiKeys`. */
  apiKeys: Readonly<Record<string, string>>;
}

let policy: HostedPolicy | null = null;

export const setHostedPolicy = (next: HostedPolicy): void => {
  policy = next;
};

export const hostedPolicy = (): HostedPolicy | null => policy;

/** The Capabilities toggles as the policy fixes them; null on the desktop. */
export const hostedToolsetPreferences = (): ToolsetPreferences | null => {
  const current = policy;
  if (current == null) return null;
  return Object.fromEntries(
    TOOLSETS.map((set) => [set.id, current.toolsets.includes(set.id)])
  );
};
