/**
 * Tells a running conversation that its tools and resources changed.
 *
 * Connectors, MCP servers and skills are described in the system prompt, which
 * is the cached prefix of every request; rewriting it mid-chat would drop the
 * cache for one sentence. A note appended to the user's next message costs
 * nothing, is saved with the conversation, and reaches the model once.
 */

/** Names are capped so a large install cannot crowd out the user's message. */
const MAX_NAMES_PER_GROUP = 40;

/** First telling vs. a change under a running chat; only the opening differs. */
export type NoticeKind = "initial" | "update";

export interface EnvironmentSnapshot {
  /** Messaging connectors that are enabled and configured. */
  connectors: string[];
  /**
   * Account connectors attached right now ("Gmail, as ada@example.com").
   * Listed separately because their MCP server is one `abacus-connectors`
   * entry whatever is behind it, and `connectors` counts messaging platforms.
   */
  accountConnectors: string[];
  /** User MCP servers, which is also how connectors are installed. */
  mcpServers: string[];
  /** Skills the agent can load. */
  skills: string[];
}

const formatGroup = (label: string, names: string[]): string => {
  if (names.length === 0) return `${label} (0): none`;
  const shown = names.slice(0, MAX_NAMES_PER_GROUP);
  const rest = names.length - shown.length;
  const suffix = rest > 0 ? `, and ${rest} more` : "";
  return `${label} (${names.length}): ${shown.join(", ")}${suffix}`;
};

/** The note itself. Read by a model: a reminder that reads like an error is worse than none. */
export const formatEnvironmentNotice = (
  snapshot: EnvironmentSnapshot,
  kind: NoticeKind = "update"
): string =>
  [
    "<system_reminder>",
    kind === "initial"
      ? "This is what you are connected to in this session:"
      : "The tools and resources available to you changed after this conversation started. This is the current state:",
    formatGroup("Messaging platforms connected", snapshot.connectors),
    formatGroup("Connectors connected", snapshot.accountConnectors),
    formatGroup("MCP servers and connectors configured", snapshot.mcpServers),
    formatGroup("Skills available", snapshot.skills),
    'Everything listed is available to you right now. Use it when it is relevant instead of saying you lack access. A connector listed as connected needs no connecting, and the account named beside it is the user\'s own: that is who they mean by "me", so do not ask them for it. A service NOT listed can usually still be attached: call connect_connector for it instead of reporting no access or asking whether to connect. This note is automatic; do not mention it to the user.',
    "</system_reminder>",
  ].join("\n");

/** Appends the note to a user message, leaving the user's own words first. */
export const appendEnvironmentNotice = (
  message: string,
  notice: string
): string => `${message}\n\n${notice}`;

/**
 * The message to actually send: the user's words, plus the note when this
 * session's conversation has not been told about the latest change.
 */
export const messageWithEnvironmentNotice = (
  notices: EnvironmentNoticeService,
  sessionId: string,
  message: string,
  snapshot: EnvironmentSnapshot
): string =>
  notices.isPending(sessionId)
    ? appendEnvironmentNotice(
        message,
        formatEnvironmentNotice(
          snapshot,
          notices.hasBeenTold(sessionId) ? "update" : "initial"
        )
      )
    : message;

/**
 * Which sessions still owe their conversation a note.
 *
 * A single counter, not a per-session list of changes: the note always states
 * the whole environment, so a session only needs to know whether it has seen
 * the latest one. A conversation never told is owed one too. A tool list is
 * a list of names, not a statement that the service asked about is behind one.
 */
export class EnvironmentNoticeService {
  private version = 0;
  private readonly announced = new Map<string, number>();

  /** Call after anything a session is told about at start has changed. */
  markChanged(): void {
    this.version += 1;
  }

  /** Call when a session's agent process starts: a fresh history forgets. */
  markSessionStarted(sessionId: string): void {
    this.announced.delete(sessionId);
  }

  /** Whether this conversation has been told anything at all yet. */
  hasBeenTold(sessionId: string): boolean {
    return this.announced.has(sessionId);
  }

  forgetSession(sessionId: string): void {
    this.announced.delete(sessionId);
  }

  /** Whether the next message should carry a note (changed, or never told). */
  isPending(sessionId: string): boolean {
    return this.announced.get(sessionId) !== this.version;
  }

  /** Marks the session current; called once the note is actually on its way. */
  markAnnounced(sessionId: string): void {
    this.announced.set(sessionId, this.version);
  }
}

/** One instance for the process, so config services need no dependency. */
export const environmentNoticeService = new EnvironmentNoticeService();
