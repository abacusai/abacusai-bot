/**
 * The oRPC contract between main and the renderer (spec 00 A). One file per
 * domain, mirroring the legacy bridge families; `legacy-map.ts` says where
 * every legacy bridge method and event went. Imported by main (to implement)
 * and by the renderer (to call), so nothing here may touch Electron.
 */
import { account } from "./account";
import { agent } from "./agent";
import { ai } from "./ai";
import { auth } from "./auth";
import { bots } from "./bots";
import { browser } from "./browser";
import { connectors } from "./connectors";
import { db } from "./db";
import { devices } from "./devices";
import { files } from "./files";
import { git } from "./git";
import { links } from "./links";
import { localModels } from "./local-models";
import { mcp } from "./mcp";
import { memory } from "./memory";
import { messaging } from "./messaging";
import { models } from "./models";
import { notch } from "./notch";
import { referrals } from "./referrals";
import { routines } from "./routines";
import { sessions } from "./sessions";
import { settings } from "./settings";
import { skills } from "./skills";
import { system } from "./system";
import { terminal } from "./terminal";
import { update } from "./update";
import { voice } from "./voice";
import { window } from "./window";
import { workspaces } from "./workspaces";

export const contract = {
  workspaces,
  git,
  files,
  sessions,
  agent,
  ai,
  bots,
  routines,
  notch,
  settings,
  models,
  localModels,
  links,
  account,
  auth,
  referrals,
  connectors,
  mcp,
  browser,
  terminal,
  memory,
  devices,
  voice,
  messaging,
  system,
  window,
  update,
  skills,
  db,
};

export type Contract = typeof contract;

/** Bumped on any breaking change to the contract's shape. */
export const CONTRACT_VERSION = 1;

export type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  AttentionEvent,
  AttentionSummary,
  RunFinishedNotice,
} from "./ai";
export type * from "./ai-thread";
export type { BotsEvent } from "./bots";
export type { RoutinesEvent } from "./routines";
export type { BrowserEvent } from "./browser";
export type { ConnectorsEvent } from "./connectors";
export type { DevicesEvent } from "./devices";
export type { FilesEvent } from "./files";

export type { McpRuntimeEvent } from "./mcp";
export type { MemoryEvent } from "./memory";
export type { MessagingEvent } from "./messaging";
export type { SettingsEvent } from "./settings";
export type { NotificationMetadata, SystemEvent, SystemInfo } from "./system";
export type { TerminalEvent, TerminalOutputChunk } from "./terminal";

export type {
  SetDensityResult,
  WindowChromeState,
  WindowEvent,
  WindowState,
} from "./window";
export type * from "./rows";
export { SUPPORTED_LANGUAGES } from "./rows";
export type * from "./agui";

export type * from "./notch";
