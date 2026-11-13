/**
 * Whether the app behind a `local` MCP connector (Roblox Studio's server
 * ships inside Studio) can serve on this computer: it does not run on this
 * system, it is not installed, it is installed with its server still off, or
 * its server is there. One answer, read by both the statuses and the connect
 * flow, so the card and the Connect button agree.
 */
import { type Connector, connectorById } from "@abacus-ai/connectors/registry";

/**
 * `other-os`: the app does not exist for this system; `none`: not a local
 * connector; `server-off`: the app is installed but has not put its server's
 * launcher in place yet (Studio does once "Enable Studio as MCP server" is on).
 */
export type LocalAppState =
  | "none"
  | "other-os"
  | "missing"
  | "server-off"
  | "installed";

/** `%NAME%` replaced by that environment variable; an unset one stays as written. */
export const expandEnv = (
  path: string,
  env: Readonly<Record<string, string | undefined>>
): string =>
  path.replace(
    /%([A-Za-z0-9_()]+)%/g,
    (whole, name: string) => env[name] ?? whole
  );

export interface LocalAppProbe {
  os: string;
  env: Readonly<Record<string, string | undefined>>;
  exists: (path: string) => boolean;
  /** The entries of a folder; none when it cannot be read. */
  list: (dir: string) => readonly string[];
}

/**
 * Whether `pattern` names something on disk. A `*` segment matches any one
 * entry of the folder before it; either separator splits segments, and the
 * one the pattern uses joins them back.
 */
const found = (pattern: string, probe: LocalAppProbe): boolean => {
  const star = pattern.search(/[\\/]\*(?=[\\/]|$)/);
  if (star < 0) return probe.exists(pattern);
  const sep = pattern[star] ?? "/";
  const dir = pattern.slice(0, star);
  const rest = pattern.slice(star + 2);
  return probe
    .list(dir)
    .some((name) => found(`${dir}${sep}${name}${rest}`, probe));
};

/** A path is usable only once every %NAME% in it is known. */
const present = (path: string, probe: LocalAppProbe): boolean => {
  const expanded = expandEnv(path, probe.env);
  return !expanded.includes("%") && found(expanded, probe);
};

export const localAppState = (
  connector: Connector,
  probe: LocalAppProbe
): LocalAppState => {
  if (connector.kind !== "mcp" || connector.local == null) return "none";
  const server = connector.local[probe.os as keyof typeof connector.local];
  if (server == null) return "other-os";
  // The launcher is the proof that counts: it is there only on an install.
  if (present(server.server, probe)) return "installed";
  return server.app.some((path) => present(path, probe))
    ? "server-off"
    : "missing";
};

/** Whether this MCP server id is a connector whose server another app ships. */
export const isLocalAppConnector = (id: string): boolean => {
  const connector = connectorById(id);
  return connector?.kind === "mcp" && connector.local != null;
};
