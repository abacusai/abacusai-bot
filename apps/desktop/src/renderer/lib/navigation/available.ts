/**
 * Which areas and pages exist where the app runs. All of them on the desktop;
 * the hosted web app drops what needs the user's own machine (capabilities
 * from features/web). Sessions stay listed on the web: their page explains
 * that coding runs on the user's computer and opens it when attached.
 */
import { isRunnerView } from "#renderer/lib/web-app";
import type { Capabilities } from "#shared/contract";

import type { LibraryPageId, SettingsPageId, ShellAreaId } from "./areas";

/** The coding view (served by the user's desktop) is sessions alone. */
export const railAreaAvailable = (
  area: ShellAreaId,
  capabilities: Capabilities
): boolean =>
  isRunnerView()
    ? area === "sessions"
    : area !== "routines" || capabilities.routines;

const LIBRARY_NEEDS: Partial<Record<LibraryPageId, keyof Capabilities>> = {
  messaging: "messaging",
  mcp: "customMcp",
  skills: "skillsInstall",
  tools: "terminal",
};

export const libraryPageAvailable = (
  page: LibraryPageId,
  capabilities: Capabilities
): boolean => {
  const needs = LIBRARY_NEEDS[page];
  return needs == null || capabilities[needs];
};

const SETTINGS_NEEDS: Partial<Record<SettingsPageId, keyof Capabilities>> = {
  account: "signIn",
  models: "providerKeys",
  environment: "terminal",
  browser: "browser",
  devices: "devices",
};

export const settingsPageAvailable = (
  page: SettingsPageId,
  capabilities: Capabilities
): boolean => {
  const needs = SETTINGS_NEEDS[page];
  return needs == null || capabilities[needs];
};

/**
 * Connector kinds the app can attach where it runs. The web app attaches the
 * platform's own (Gmail, Slack, Drive, ...); the rest need the user's machine.
 */
export const connectorKindAvailable = (
  kind: string,
  capabilities: Capabilities
): boolean => {
  switch (kind) {
    case "platform":
      return true;
    case "messaging":
      return capabilities.messaging;
    case "mcp":
      return capabilities.customMcp;
    default:
      return capabilities.providerKeys;
  }
};
