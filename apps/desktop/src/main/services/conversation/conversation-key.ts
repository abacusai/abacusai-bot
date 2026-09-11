import {
  conversationBelongsToWorkspace,
  conversationKey as sharedConversationKey,
  conversationRefFromKey,
  draftConversationRef,
  sessionConversationRef,
  type ConversationKey,
} from "#shared/conversation-scope";

export type DraftConversationScope = {
  workspaceId: string;
  kind: "draft";
};

export type SessionConversationScope = {
  workspaceId: string;
  kind: "session";
  sessionId: string;
};

export type ConversationScope =
  | DraftConversationScope
  | SessionConversationScope;

export type { ConversationKey } from "#shared/conversation-scope";

export const conversationKey = (scope: ConversationScope): ConversationKey => {
  const ref =
    scope.kind === "draft"
      ? draftConversationRef(scope.workspaceId)
      : sessionConversationRef(scope.workspaceId, scope.sessionId);
  return sharedConversationKey(ref);
};

export const parseConversationKey = (
  key: ConversationKey
): ConversationScope | null => {
  const ref = conversationRefFromKey(key);
  if (ref == null) return null;
  return ref.kind === "draft"
    ? { workspaceId: ref.workspaceId, kind: "draft" }
    : {
        workspaceId: ref.workspaceId,
        kind: "session",
        sessionId: ref.sessionId,
      };
};

export { conversationBelongsToWorkspace };
