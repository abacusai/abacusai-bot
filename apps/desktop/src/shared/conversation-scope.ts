export const CONVERSATION_KEY_VERSION = 1 as const;

export type DraftConversationRef = {
  version: typeof CONVERSATION_KEY_VERSION;
  kind: "draft";
  workspaceId: string;
};

export type SessionConversationRef = {
  version: typeof CONVERSATION_KEY_VERSION;
  kind: "session";
  workspaceId: string;
  sessionId: string;
};

export type ConversationRef = DraftConversationRef | SessionConversationRef;

export type ConversationKey = string & {
  readonly __conversationKey: unique symbol;
};

export type DraftConversationKey = ConversationKey & {
  readonly __draftConversationKey: unique symbol;
};

export type SessionConversationKey = ConversationKey & {
  readonly __sessionConversationKey: unique symbol;
};

const requireId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} cannot be empty`);
  return normalized;
};

export const draftConversationRef = (
  workspaceId: string
): DraftConversationRef => ({
  version: CONVERSATION_KEY_VERSION,
  kind: "draft",
  workspaceId: requireId(workspaceId, "workspaceId"),
});

export const sessionConversationRef = (
  workspaceId: string,
  sessionId: string
): SessionConversationRef => ({
  version: CONVERSATION_KEY_VERSION,
  kind: "session",
  workspaceId: requireId(workspaceId, "workspaceId"),
  sessionId: requireId(sessionId, "sessionId"),
});

export const conversationKey = (ref: ConversationRef): ConversationKey =>
  JSON.stringify(
    ref.kind === "draft"
      ? ["conversation", ref.version, ref.workspaceId, ref.kind]
      : ["conversation", ref.version, ref.workspaceId, ref.kind, ref.sessionId]
  ) as ConversationKey;

export const draftConversationKey = (
  workspaceId: string
): DraftConversationKey =>
  conversationKey(draftConversationRef(workspaceId)) as DraftConversationKey;

export const sessionConversationKey = (
  workspaceId: string,
  sessionId: string
): SessionConversationKey =>
  conversationKey(
    sessionConversationRef(workspaceId, sessionId)
  ) as SessionConversationKey;

export const conversationRefFromKey = (
  key: ConversationKey
): ConversationRef | null => {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value)) return null;
    const [namespace, version, workspaceId, kind, sessionId, ...rest] = value;
    if (
      namespace !== "conversation" ||
      version !== CONVERSATION_KEY_VERSION ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      rest.length !== 0
    ) {
      return null;
    }
    if (kind === "draft" && sessionId === undefined) {
      return draftConversationRef(workspaceId);
    }
    if (
      kind === "session" &&
      typeof sessionId === "string" &&
      sessionId.length > 0
    ) {
      return sessionConversationRef(workspaceId, sessionId);
    }
    return null;
  } catch {
    return null;
  }
};

export const conversationBelongsToWorkspace = (
  key: ConversationKey,
  workspaceId: string
): boolean => conversationRefFromKey(key)?.workspaceId === workspaceId;

/**
 * The browser resource the agent creates for itself in a conversation that has
 * none open. One fixed id, so the renderer and main agree on it.
 */
export const AGENT_BROWSER_RESOURCE_ID = "agent-browser";
