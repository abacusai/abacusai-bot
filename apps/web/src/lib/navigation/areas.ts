/**
 * The app's areas and their fixed pages, shared by routes, the shell, the
 * command menu and the features without any of them importing another.
 */
import type { FileRoutesByTo } from "#renderer/routeTree.gen";

const SHELL_AREAS = [
  "bots",
  "sessions",
  "routines",
  "artifacts",
  "library",
  "settings",
] as const;
export type ShellAreaId = (typeof SHELL_AREAS)[number];

/** Top of the rail (F11: Library is the fifth). */
export const RAIL_AREAS = [
  "bots",
  "sessions",
  "routines",
  "artifacts",
  "library",
] as const satisfies readonly ShellAreaId[];

export const AREA_HOME = {
  bots: "/bots/new",
  sessions: "/sessions/new",
  routines: "/routines",
  artifacts: "/artifacts",
  library: "/library/connectors",
  settings: "/settings/general",
} as const satisfies Record<ShellAreaId, keyof FileRoutesByTo>;

export const SETTINGS_PAGES = [
  "general",
  "appearance",
  "notifications",
  "memory",
  "usage",
  "account",
  "models",
  "environment",
  "about",
  "browser",
  "devices",
  "language",
  "keyboard",
] as const;
export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

export const LIBRARY_PAGES = [
  "connectors",
  "messaging",
  "mcp",
  "skills",
  "tools",
] as const;
/** @public Library route page identifiers. */
export type LibraryPageId = (typeof LIBRARY_PAGES)[number];

/** Canvas page 11. */
export const ONBOARDING_STEPS = [
  "welcome",
  "connect",
  "connected",
  "models",
  "connectors",
  "first-bot",
  "done",
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];
