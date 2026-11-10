/**
 * Whether the app behind a `local` MCP connector (Roblox Studio's server
 * ships inside Studio) can serve on this computer: it does not run on this
 * system, it is not installed, or it is there. One answer, read by both the
 * statuses and the connect flow, so the card and the Connect button agree.
 */
import type { Connector } from "@abacus-ai/connectors/registry";

/** `other-os`: the app does not exist for this system; `none`: not a local connector. */
export type LocalAppState = "none" | "other-os" | "missing" | "installed";

/** `%NAME%` replaced by that environment variable; an unset one stays as written. */
export const expandEnv = (
  path: string,
  env: Readonly<Record<string, string | undefined>>
): string =>
  path.replace(
    /%([A-Za-z0-9_]+)%/g,
    (whole, name: string) => env[name] ?? whole
  );

export interface LocalAppProbe {
  os: string;
  env: Readonly<Record<string, string | undefined>>;
  exists: (path: string) => boolean;
}

export const localAppState = (
  connector: Connector,
  probe: LocalAppProbe
): LocalAppState => {
  if (connector.kind !== "mcp" || connector.local == null) return "none";
  const server = connector.local[probe.os as keyof typeof connector.local];
  if (server == null) return "other-os";
  const path = expandEnv(server.app, probe.env);
  // An unexpanded %NAME% is not a path that can exist.
  if (path.includes("%")) return "missing";
  return probe.exists(path) ? "installed" : "missing";
};
