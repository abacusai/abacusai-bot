/**
 * What the web app's coding view may call on this desktop. It is the user's
 * own account on their own machine, but reached over the internet, so the
 * list is coding only: sessions with their agents, workspaces, files, git
 * and terminals, and the reads the shell needs to draw. Nothing that changes
 * sign-in, keys, updates, windows or what agents may do in general.
 */
import type { ProcedurePatterns } from "../../rpc/procedure-policy";

export const RUNNER_PROCEDURES: ProcedurePatterns = [
  "sessions.*",
  "workspaces.*",
  "files.*",
  "git.*",
  "terminal.*",
  "ai.*",
  "agent.*",

  // Every table's reads; writes to the coding ones and the user's prefs.
  "db.*.snapshot",
  "db.*.changes",
  "db.sessions.*",
  "db.workspaces.*",
  "db.prefs.update",

  "models.list",
  "account.state",
  "account.usage",
  "account.abacus",
  "connectors.statuses",
  "connectors.events",
  "mcp.list",
  "mcp.runtime.*",
  "skills.listInstalled",
  "memory.customInstructions.get",
  "memory.events",

  "settings.get",
  "settings.events",
  "settings.promptHistory.*",
  "settings.toolsets.get",
  "settings.defaultMode.get",
  "settings.sandboxSupport",
  "settings.execBackend.get",
  "settings.notifications.get",

  "system.info",
  "system.capabilities",
  "system.funnelStep",
  "system.acknowledgeLegacyDrafts",
  "system.logs.append",
  "system.events",

  "window.state",
  "window.chrome",
  "window.events",
  "window.ready",
  "window.activity",

  // Streams the shell opens for every area; quiet when nothing happens.
  "*.events",
  "update.status",
];
