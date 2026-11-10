/**
 * The words for a connector whose server ships inside another app on the
 * user's computer (Roblox Studio): what the card says while that app is not
 * installed or not answering, and the one thing that fixes it. The host
 * decides the state (`app-missing`, `app-not-ready`); this only words it.
 */
import type { Connector } from "@abacus-ai/connectors/registry";
import type { ConnectorStatus } from "@abacus-ai/contract/contracts";

export type LocalAppReason = "app-missing" | "app-not-ready";

interface LocalAppCopy {
  /** Kept in view while connected: the app has to be open and serving. */
  ready: string;
  missing: string;
  notReady: string;
  get: string;
}

const COPY: Readonly<Record<string, LocalAppCopy>> = {
  "roblox-studio": {
    ready: "phase5.localApp.robloxStudio.ready",
    missing: "phase5.localApp.robloxStudio.missing",
    notReady: "phase5.localApp.robloxStudio.notReady",
    get: "phase5.localApp.robloxStudio.get",
  },
};

/** The copy for a `local` connector; null for any other. */
export const localAppCopy = (
  connector: Connector | undefined
): LocalAppCopy | null =>
  connector?.kind === "mcp" && connector.local != null
    ? (COPY[connector.id] ?? null)
    : null;

/** Why its app cannot serve now, when that is the news on the card. */
export const localAppReason = (
  status: ConnectorStatus | undefined
): LocalAppReason | null =>
  status?.reason === "app-missing" || status?.reason === "app-not-ready"
    ? status.reason
    : null;

/** The pill for that reason. */
export const LOCAL_APP_PILL: Readonly<Record<LocalAppReason, string>> = {
  "app-missing": "phase5.appMissing",
  "app-not-ready": "phase5.appNotReady",
};

/**
 * Hidden where it cannot work: its app does not run on this system, or the
 * host has not said yet (a card that might not connect is worse than none).
 */
export const localAppHidden = (
  connector: Connector,
  status: ConnectorStatus | undefined
): boolean =>
  connector.kind === "mcp" &&
  connector.local != null &&
  (status == null || status.reason === "other-os");
