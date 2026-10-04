/**
 * What a browser tab of the hosted web app may call. Everything else in the
 * contract is refused before it reaches a handler (main/rpc/procedure-policy):
 * the host runs on our machines, so procedures that read or write paths,
 * run commands, open windows or change what an agent may do stay desktop-only.
 *
 * Reads of every DB table stay open because the screens subscribe to all of
 * them at start; the tables only hold this user's own rows.
 */
import type { ProcedurePatterns } from "#main/rpc/procedure-policy";

export const WEB_PROCEDURES: ProcedurePatterns = [
  // Bot chats: the relay, the agent behind each chat, and their queues.
  "ai.*",
  "agent.feedback",
  "agent.start",
  "agent.stop",
  "agent.state",
  "agent.setModel",
  "agent.reset",
  "agent.switchConversation",
  "agent.respondPermission",
  "agent.skills",
  "agent.queue.*",
  "sessions.turnState",
  "bots.*",
  "memory.*",
  "models.list",

  // The account the session cookie signed in; signing out is the website's.
  "account.usage",
  "account.abacus",
  "account.state",
  "account.skipOnboarding",

  // Platform connectors (Gmail, Slack, ...) through the platform's own pages.
  "connectors.*",
  "mcp.list",
  // Re-reads a session's tools after a connector attaches, which is what
  // resumes a turn waiting on it. Only the platform gateway is configured.
  "mcp.refresh",
  "mcp.runtime.*",

  "referrals.summary",
  "referrals.gmailContacts",
  "referrals.sendEmail",

  // Settings that only shape this user's own experience.
  "settings.get",
  "settings.promptHistory.*",
  "settings.keys.listProviders",
  "settings.setDefaultModel",
  "settings.toolsets.get",
  "settings.defaultMode.get",
  "settings.sandboxSupport",
  "settings.notifications.*",
  "settings.execBackend.get",
  "settings.events",

  "skills.listInstalled",
  "skills.search",

  "messaging.snapshot",
  "messaging.events",

  // Event streams the shell opens at start for every area. They stay quiet
  // here: nothing on the host produces routines, browser or device events.
  "routines.events",
  "browser.events",
  "devices.events",
  "files.events",

  "system.info",
  "system.capabilities",
  "system.funnelStep",
  "system.acknowledgeLegacyDrafts",
  "system.logs.append",
  "system.notify",
  "system.openExternal",
  "system.events",

  "update.status",
  "update.events",

  // A tab is a plain window: its state, readiness and activity beacons.
  "window.state",
  "window.chrome",
  "window.events",
  "window.ready",
  "window.activity",

  // Every table's reads; writes only where the row is the user's own.
  "db.*.snapshot",
  "db.*.changes",
  "db.bots.*",
  "db.sessions.update",
  "db.sessions.delete",
  "db.memories.delete",
  "db.prefs.update",
];
