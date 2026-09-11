import {
  conversationRefFromKey,
  draftConversationKey,
  sessionConversationKey,
  type ConversationKey,
  type DraftConversationKey,
  type SessionConversationKey,
} from "#shared/conversation-scope";

export {
  CONVERSATION_KEY_VERSION,
  conversationKey,
  conversationRefFromKey,
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
  type ConversationKey,
  type ConversationRef,
  type DraftConversationKey,
  type DraftConversationRef,
  type SessionConversationKey,
  type SessionConversationRef,
} from "#shared/conversation-scope";

export const RIGHT_PANEL_SINGLETON_IDS = {
  files: "files",
} as const;

export type RightPanelSingletonKind = keyof typeof RIGHT_PANEL_SINGLETON_IDS;
export type RightPanelSingletonId =
  (typeof RIGHT_PANEL_SINGLETON_IDS)[RightPanelSingletonKind];

export type RightPanelResourceType =
  | "agents"
  | "artifact"
  | "browser"
  | "device"
  | "document"
  | "file"
  | "image"
  | "simulator"
  | "url";

type RightPanelDescriptorBase = {
  id: string;
  title: string;
};

export type RightPanelSingletonDescriptor = RightPanelDescriptorBase & {
  kind: RightPanelSingletonKind;
  id: RightPanelSingletonId;
};

export type RightPanelResourceDescriptor = RightPanelDescriptorBase & {
  kind: "resource";
  resourceType: RightPanelResourceType;
  resourceKey: string;
  metadata?: Readonly<Record<string, unknown>>;
};

export type RightPanelDescriptor =
  | RightPanelSingletonDescriptor
  | RightPanelResourceDescriptor;

export type AgentsAvailability = {
  available: boolean;
  reason: string | null;
};

export type RightPanelScope = {
  workspaceId: string;
  sessionId: string | null;
};

/** @deprecated Prefer ConversationKey and the conversation key constructors. */
export type RightPanelScopeKey = ConversationKey;

export type RightPanelScopeState = {
  descriptors: readonly RightPanelDescriptor[];
  activeId: string | null;
  isOpen: boolean;
  agentsAvailability: AgentsAvailability;
};

export type RightPanelState = {
  scopes: Readonly<Record<string, RightPanelScopeState>>;
};

export type RightPanelAction =
  | {
      type: "focus";
      scope: RightPanelScopeKey;
      descriptor: RightPanelDescriptor;
    }
  | { type: "focus-existing"; scope: RightPanelScopeKey; id: string }
  | { type: "close"; scope: RightPanelScopeKey; id: string }
  | { type: "close-active"; scope: RightPanelScopeKey }
  | { type: "hide"; scope: RightPanelScopeKey }
  | { type: "show"; scope: RightPanelScopeKey }
  | { type: "reopen"; scope: RightPanelScopeKey }
  | {
      type: "set-agents-availability";
      scope: RightPanelScopeKey;
      availability: AgentsAvailability;
    }
  | {
      type: "promote-draft";
      from: DraftConversationKey;
      to: SessionConversationKey;
    }
  | { type: "dispose-scope"; scope: ConversationKey }
  | { type: "dispose-workspace"; workspaceId: string };

const EMPTY_AGENTS_AVAILABILITY: AgentsAvailability = {
  available: false,
  reason: null,
};

const createScopeState = (): RightPanelScopeState => ({
  descriptors: [],
  activeId: null,
  isOpen: false,
  agentsAvailability: EMPTY_AGENTS_AVAILABILITY,
});

export const createRightPanelState = (): RightPanelState => ({ scopes: {} });

/** Compatibility wrapper for callers that still describe a panel scope. */
export const rightPanelScopeKey = ({
  workspaceId,
  sessionId,
}: RightPanelScope): RightPanelScopeKey =>
  sessionId == null
    ? draftConversationKey(workspaceId)
    : sessionConversationKey(workspaceId, sessionId);

export const createSingletonRightPanelDescriptor = (
  kind: RightPanelSingletonKind,
  title: string
): RightPanelSingletonDescriptor => ({
  kind,
  id: RIGHT_PANEL_SINGLETON_IDS[kind],
  title,
});

export const rightPanelResourceId = (
  resourceType: RightPanelResourceType,
  resourceKey: string
): string => `resource:${JSON.stringify([resourceType, resourceKey])}`;

export const createResourceRightPanelDescriptor = ({
  id,
  resourceType,
  resourceKey,
  title,
  metadata,
}: Omit<RightPanelResourceDescriptor, "id" | "kind"> & {
  id?: string;
}): RightPanelResourceDescriptor => ({
  kind: "resource",
  id:
    id == null || id.length === 0
      ? rightPanelResourceId(resourceType, resourceKey)
      : id,
  resourceType,
  resourceKey,
  title,
  metadata,
});

const singletonKinds = new Set<string>(Object.keys(RIGHT_PANEL_SINGLETON_IDS));
const resourceTypes = new Set<string>([
  "agents",
  "artifact",
  "browser",
  "device",
  "document",
  "file",
  "image",
  "simulator",
  "url",
] satisfies RightPanelResourceType[]);

export const isRightPanelDescriptor = (
  value: unknown
): value is RightPanelDescriptor => {
  if (value == null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.title !== "string"
  ) {
    return false;
  }
  if (candidate.kind === "resource") {
    return (
      typeof candidate.resourceType === "string" &&
      resourceTypes.has(candidate.resourceType) &&
      typeof candidate.resourceKey === "string" &&
      candidate.resourceKey.length > 0
    );
  }
  return (
    typeof candidate.kind === "string" &&
    singletonKinds.has(candidate.kind) &&
    candidate.id ===
      RIGHT_PANEL_SINGLETON_IDS[candidate.kind as RightPanelSingletonKind]
  );
};

export const selectRightPanelScope = (
  state: RightPanelState,
  scope: RightPanelScopeKey
): RightPanelScopeState => state.scopes[scope] ?? createScopeState();

const updateScope = (
  state: RightPanelState,
  scope: RightPanelScopeKey,
  update: (current: RightPanelScopeState) => RightPanelScopeState
): RightPanelState => {
  const current = selectRightPanelScope(state, scope);
  const next = update(current);
  if (next === current) return state;
  return { scopes: { ...state.scopes, [scope]: next } };
};

const closeDescriptor = (
  current: RightPanelScopeState,
  id: string
): RightPanelScopeState => {
  const closingIndex = current.descriptors.findIndex(
    (descriptor) => descriptor.id === id
  );
  if (closingIndex === -1) return current;

  const descriptors = current.descriptors.filter(
    (_, index) => index !== closingIndex
  );
  if (current.activeId !== id) return { ...current, descriptors };

  const nextActive = descriptors[closingIndex] ?? descriptors[closingIndex - 1];
  return {
    ...current,
    descriptors,
    activeId: nextActive?.id ?? null,
    isOpen: true,
  };
};

const mergePromotedScope = (
  draft: RightPanelScopeState,
  session: RightPanelScopeState | undefined
): RightPanelScopeState => {
  if (session == null) return draft;
  const draftIds = new Set(draft.descriptors.map(({ id }) => id));
  return {
    descriptors: [
      ...draft.descriptors,
      ...session.descriptors.filter(({ id }) => !draftIds.has(id)),
    ],
    activeId:
      draft.activeId ??
      (session.descriptors.some(({ id }) => id === session.activeId)
        ? session.activeId
        : null),
    isOpen: draft.isOpen,
    agentsAvailability: draft.agentsAvailability,
  };
};

export const rightPanelReducer = (
  state: RightPanelState,
  action: RightPanelAction
): RightPanelState => {
  switch (action.type) {
    case "focus":
      if (!isRightPanelDescriptor(action.descriptor)) return state;
      return updateScope(state, action.scope, (current) => {
        const existingIndex = current.descriptors.findIndex(
          ({ id }) => id === action.descriptor.id
        );
        const descriptors = [...current.descriptors];
        if (existingIndex === -1) descriptors.push(action.descriptor);
        else descriptors[existingIndex] = action.descriptor;
        return {
          ...current,
          descriptors,
          activeId: action.descriptor.id,
          isOpen: true,
        };
      });

    case "focus-existing":
      return updateScope(state, action.scope, (current) => {
        if (!current.descriptors.some(({ id }) => id === action.id)) {
          return current;
        }
        return { ...current, activeId: action.id, isOpen: true };
      });

    case "close":
      return updateScope(state, action.scope, (current) =>
        closeDescriptor(current, action.id)
      );

    case "close-active":
      return updateScope(state, action.scope, (current) =>
        current.activeId == null
          ? current
          : closeDescriptor(current, current.activeId)
      );

    case "hide":
      return updateScope(state, action.scope, (current) =>
        current.isOpen ? { ...current, isOpen: false } : current
      );

    case "show":
      return updateScope(state, action.scope, (current) =>
        current.isOpen ? current : { ...current, isOpen: true }
      );

    case "reopen":
      return updateScope(state, action.scope, (current) => {
        if (current.descriptors.length === 0) return current;
        const activeId = current.descriptors.some(
          ({ id }) => id === current.activeId
        )
          ? current.activeId
          : current.descriptors[0]!.id;
        if (current.isOpen && activeId === current.activeId) return current;
        return { ...current, activeId, isOpen: true };
      });

    case "set-agents-availability":
      return updateScope(state, action.scope, (current) => ({
        ...current,
        agentsAvailability: {
          available: action.availability.available,
          reason: action.availability.available
            ? null
            : action.availability.reason,
        },
      }));

    case "promote-draft": {
      const fromRef = conversationRefFromKey(action.from);
      const toRef = conversationRefFromKey(action.to);
      if (
        fromRef?.kind !== "draft" ||
        toRef?.kind !== "session" ||
        fromRef.workspaceId !== toRef.workspaceId
      ) {
        return state;
      }
      const draft = state.scopes[action.from];
      if (draft == null) return state;
      const { [action.from]: _draft, ...scopes } = state.scopes;
      return {
        scopes: {
          ...scopes,
          [action.to]: mergePromotedScope(draft, scopes[action.to]),
        },
      };
    }

    case "dispose-scope": {
      if (!(action.scope in state.scopes)) return state;
      const { [action.scope]: _disposed, ...scopes } = state.scopes;
      return { scopes };
    }

    case "dispose-workspace": {
      const scopes = Object.fromEntries(
        Object.entries(state.scopes).filter(([key]) => {
          const ref = conversationRefFromKey(key as ConversationKey);
          return ref?.workspaceId !== action.workspaceId;
        })
      );
      return Object.keys(scopes).length === Object.keys(state.scopes).length
        ? state
        : { scopes };
    }
  }
};
