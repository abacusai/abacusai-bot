import type { ReactElement, ReactNode } from "react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

import type { MessageQueueEntry } from "./agent-types";
import {
  conversationReducer,
  createInitialConversationState,
} from "./conversation-reducer";
import type {
  ConversationActivity,
  ConversationDerivationCache,
  ConversationDerivations,
  SubtaskSummary,
  TodoState,
  ToolGroup,
  ToolState,
} from "./derivations";
import { createConversationDerivationCache } from "./derivations";
import type {
  ConversationCommands,
  ConversationEvent,
  ConversationState,
  ConversationStatus,
  ConversationTransport,
  PermissionPrompt,
  RetryState,
  Segment,
} from "./types";

const INITIAL_STATE = createInitialConversationState();
const INITIAL_DERIVATIONS =
  createConversationDerivationCache().update(INITIAL_STATE);

type SliceKey =
  | "state"
  | "segments"
  | "messages"
  | "queue"
  | "permission"
  | "status"
  | "overview"
  | "activity"
  | "checkpoints"
  | "todos"
  | "groups"
  | "grouped-segments"
  | "subtasks"
  | `tool:${string}`
  | `tool-ui:${string}`
  | `group:${string}`
  | `group-ui:${string}`
  | `segment:${string}`;

interface ConversationRecord {
  state: ConversationState;
  segments: Segment[];
  cache: ConversationDerivationCache;
  derivations: ConversationDerivations;
  expandedTools: Set<string>;
  expandedGroups: Set<string>;
  overview: ConversationOverview;
}

export interface ConversationOverview {
  conversationId: string | null;
  status: ConversationStatus;
  title: string | null;
  retry: RetryState | null;
  online: boolean;
  credits: number;
  spinner: string | null;
  error: ConversationState["error"];
}

const EMPTY_OVERVIEW: ConversationOverview = {
  conversationId: null,
  status: INITIAL_STATE.status,
  title: null,
  retry: null,
  online: true,
  credits: 0,
  spinner: null,
  error: null,
};

function sameSegments(left: Segment[], right: Segment[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function overviewFor(
  conversationId: string,
  state: ConversationState
): ConversationOverview {
  return {
    conversationId,
    status: state.status,
    title: state.title,
    retry: state.retry,
    online: state.online,
    credits: state.credits,
    spinner: state.spinner,
    error: state.error,
  };
}

function sameOverview(
  left: ConversationOverview,
  right: ConversationOverview
): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.status === right.status &&
    left.title === right.title &&
    left.retry === right.retry &&
    left.online === right.online &&
    left.credits === right.credits &&
    left.spinner === right.spinner &&
    left.error === right.error
  );
}

function createRecord(
  conversationId: string,
  state = INITIAL_STATE
): ConversationRecord {
  const cache = createConversationDerivationCache();
  return {
    state,
    segments: state.segments,
    cache,
    derivations: cache.update(state),
    expandedTools: new Set(),
    expandedGroups: new Set(),
    overview: overviewFor(conversationId, state),
  };
}

export interface ConversationStore {
  get(conversationId: string): ConversationState;
  getAll(): ReadonlyMap<string, ConversationState>;
  getSegments(conversationId: string): Segment[];
  getDerivations(conversationId: string): ConversationDerivations;
  getOverview(conversationId: string | null): ConversationOverview;
  getTool(conversationId: string, toolCallId: string): ToolState | undefined;
  getToolGroup(conversationId: string, groupId: string): ToolGroup | undefined;
  isToolExpanded(conversationId: string, toolCallId: string): boolean;
  isToolGroupExpanded(conversationId: string, groupId: string): boolean;
  setToolExpanded(
    conversationId: string,
    toolCallId: string,
    expanded: boolean
  ): void;
  setToolGroupExpanded(
    conversationId: string,
    groupId: string,
    expanded: boolean
  ): void;
  remove(conversationId: string): void;
  clearAll(): void;
  subscribeSlice(
    conversationId: string,
    key: SliceKey,
    listener: () => void
  ): () => void;
  readonly transport: ConversationTransport | undefined;
}

export function createConversationStore(
  transport?: ConversationTransport
): ConversationStore {
  let records = new Map<string, ConversationRecord>();
  const unknownOverviews = new Map<string, ConversationOverview>();
  const sliceListeners = new Map<string, Map<SliceKey, Set<() => void>>>();

  function listenerMap(conversationId: string): Map<SliceKey, Set<() => void>> {
    let map = sliceListeners.get(conversationId);
    if (!map) {
      map = new Map();
      sliceListeners.set(conversationId, map);
    }
    return map;
  }

  function notify(conversationId: string, key: SliceKey): void {
    const listeners = sliceListeners.get(conversationId)?.get(key);
    if (listeners) for (const listener of listeners) listener();
  }

  function notifyToolDiff(
    conversationId: string,
    previous: ReadonlyMap<string, ToolState>,
    next: ReadonlyMap<string, ToolState>
  ): void {
    const ids = new Set([...previous.keys(), ...next.keys()]);
    for (const id of ids) {
      if (previous.get(id) !== next.get(id))
        notify(conversationId, `tool:${id}`);
    }
  }

  function notifyGroupDiff(
    conversationId: string,
    previous: ReadonlyMap<string, ToolGroup>,
    next: ReadonlyMap<string, ToolGroup>
  ): void {
    const ids = new Set([...previous.keys(), ...next.keys()]);
    for (const id of ids) {
      if (previous.get(id) !== next.get(id))
        notify(conversationId, `group:${id}`);
    }
  }

  function dispatch(conversationId: string, event: ConversationEvent): void {
    const stamped =
      event.kind === "event" && event.receivedAt === undefined
        ? { ...event, receivedAt: Date.now() }
        : event;
    const previous =
      records.get(conversationId) ?? createRecord(conversationId);
    const nextState = conversationReducer(previous.state, stamped);
    if (nextState === previous.state) return;

    const nextDerivations = previous.cache.update(nextState);
    const nextSegments = sameSegments(previous.segments, nextState.segments)
      ? previous.segments
      : nextState.segments;
    const candidateOverview = overviewFor(conversationId, nextState);
    const nextOverview = sameOverview(previous.overview, candidateOverview)
      ? previous.overview
      : candidateOverview;
    const next: ConversationRecord = {
      state: nextState,
      segments: nextSegments,
      cache: previous.cache,
      derivations: nextDerivations,
      expandedTools: previous.expandedTools,
      expandedGroups: previous.expandedGroups,
      overview: nextOverview,
    };

    records = new Map(records);
    records.set(conversationId, next);

    notify(conversationId, "state");
    if (previous.segments !== next.segments) notify(conversationId, "segments");
    if (previous.derivations.messages !== next.derivations.messages)
      notify(conversationId, "messages");
    if (previous.state.queuedMessages !== next.state.queuedMessages)
      notify(conversationId, "queue");
    if (previous.state.pendingPermission !== next.state.pendingPermission)
      notify(conversationId, "permission");
    if (previous.state.status !== next.state.status)
      notify(conversationId, "status");
    if (previous.state.checkpoints !== next.state.checkpoints)
      notify(conversationId, "checkpoints");
    if (previous.overview !== next.overview) notify(conversationId, "overview");
    if (previous.derivations.activity !== next.derivations.activity)
      notify(conversationId, "activity");
    if (previous.derivations.todos !== next.derivations.todos)
      notify(conversationId, "todos");
    if (previous.derivations.groups !== next.derivations.groups)
      notify(conversationId, "groups");
    if (
      previous.derivations.groupedSegments !== next.derivations.groupedSegments
    )
      notify(conversationId, "grouped-segments");
    if (previous.derivations.subtasks !== next.derivations.subtasks)
      notify(conversationId, "subtasks");
    notifyToolDiff(
      conversationId,
      previous.derivations.tools,
      next.derivations.tools
    );
    notifyGroupDiff(
      conversationId,
      previous.derivations.groupsById,
      next.derivations.groupsById
    );
  }

  transport?.subscribe(dispatch);

  return {
    get: (conversationId) =>
      records.get(conversationId)?.state ?? INITIAL_STATE,
    getAll: () =>
      new Map(
        [...records].map(([conversationId, record]) => [
          conversationId,
          record.state,
        ])
      ),
    getSegments: (conversationId) =>
      records.get(conversationId)?.segments ?? INITIAL_STATE.segments,
    getDerivations: (conversationId) =>
      records.get(conversationId)?.derivations ?? INITIAL_DERIVATIONS,
    getOverview: (conversationId) =>
      conversationId === null
        ? EMPTY_OVERVIEW
        : (records.get(conversationId)?.overview ??
          (() => {
            const existing = unknownOverviews.get(conversationId);
            if (existing) return existing;
            const overview = { ...EMPTY_OVERVIEW, conversationId };
            unknownOverviews.set(conversationId, overview);
            return overview;
          })()),
    getTool: (conversationId, toolCallId) =>
      records.get(conversationId)?.derivations.tools.get(toolCallId),
    getToolGroup: (conversationId, groupId) =>
      records.get(conversationId)?.derivations.groupsById.get(groupId),
    isToolExpanded: (conversationId, toolCallId) =>
      records.get(conversationId)?.expandedTools.has(toolCallId) ?? false,
    isToolGroupExpanded: (conversationId, groupId) =>
      records.get(conversationId)?.expandedGroups.has(groupId) ?? false,
    setToolExpanded(conversationId, toolCallId, expanded) {
      const record =
        records.get(conversationId) ?? createRecord(conversationId);
      if (record.expandedTools.has(toolCallId) === expanded) return;
      const expandedTools = new Set(record.expandedTools);
      if (expanded) expandedTools.add(toolCallId);
      else expandedTools.delete(toolCallId);
      records = new Map(records);
      records.set(conversationId, { ...record, expandedTools });
      notify(conversationId, `tool-ui:${toolCallId}`);
    },
    setToolGroupExpanded(conversationId, groupId, expanded) {
      const record =
        records.get(conversationId) ?? createRecord(conversationId);
      if (record.expandedGroups.has(groupId) === expanded) return;
      const expandedGroups = new Set(record.expandedGroups);
      if (expanded) expandedGroups.add(groupId);
      else expandedGroups.delete(groupId);
      records = new Map(records);
      records.set(conversationId, { ...record, expandedGroups });
      notify(conversationId, `group-ui:${groupId}`);
    },
    remove(conversationId) {
      if (!records.has(conversationId)) return;
      records = new Map(records);
      records.delete(conversationId);
      const keys = sliceListeners.get(conversationId)?.keys() ?? [];
      for (const key of keys) notify(conversationId, key);
    },
    clearAll() {
      if (records.size === 0) return;
      const conversationIds = [...records.keys()];
      records = new Map();
      for (const conversationId of conversationIds) {
        const keys = sliceListeners.get(conversationId)?.keys() ?? [];
        for (const key of keys) notify(conversationId, key);
      }
    },
    subscribeSlice(conversationId, key, listener) {
      const map = listenerMap(conversationId);
      let listeners = map.get(key);
      if (!listeners) {
        listeners = new Set();
        map.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) map.delete(key);
        if (map.size === 0) sliceListeners.delete(conversationId);
      };
    },
    transport,
  };
}

function requireTransport(store: ConversationStore): ConversationTransport {
  if (!store.transport)
    throw new Error("ConversationProvider requires a command transport");
  return store.transport;
}

function permissionToolCallId(prompt: PermissionPrompt | null): string {
  if (!prompt) throw new Error("No permission request is active");
  return prompt.request.tool.id;
}

function createCommands(
  store: ConversationStore,
  conversationId: string | null
): ConversationCommands {
  return {
    sendMessage: (text, attachments, options) =>
      requireTransport(store).sendMessage(
        conversationId,
        text,
        attachments,
        options
      ),
    stopProcessing: () =>
      requireTransport(store).stopProcessing(conversationId),
    respondToPermission: (decision) =>
      requireTransport(store).respondToPermission(
        conversationId,
        permissionToolCallId(
          conversationId === null
            ? null
            : store.get(conversationId).pendingPermission
        ),
        decision
      ),
    enqueueMessage: (text, options) =>
      requireTransport(store).enqueueMessage(conversationId, text, options),
    dequeueMessages: (options) =>
      requireTransport(store).dequeueMessages(conversationId, options),
    sendQueuedMessage: (id) =>
      requireTransport(store).sendQueuedMessage(conversationId, id),
    removeQueuedMessage: (id, options) =>
      requireTransport(store).removeQueuedMessage(conversationId, id, options),
    updateQueuedMessage: (id, text) =>
      requireTransport(store).updateQueuedMessage(conversationId, id, text),
    clearQueue: (options) =>
      requireTransport(store).clearQueue(conversationId, options),
    selectConversation: (id) => requireTransport(store).selectConversation(id),
    createConversation: () => requireTransport(store).createConversation(),
    deleteConversation: (id) => requireTransport(store).deleteConversation(id),
    renameConversation: (id, title) =>
      requireTransport(store).renameConversation(id, title),
    // Takes an explicit id (like rename), so spread here, not curryOptional.
    ...(store.transport?.submitConversationFeedback && {
      submitConversationFeedback: (id: string, feedback: string) =>
        requireTransport(store).submitConversationFeedback!(id, feedback),
    }),
    loadMoreConversations: (offset) =>
      requireTransport(store).loadMoreConversations(offset),
    refreshConversations: () => requireTransport(store).refreshConversations(),
    setModel: (model) => requireTransport(store).setModel(model),
    setPermissionMode: (mode) =>
      requireTransport(store).setPermissionMode(mode),
    clearConversation: () =>
      requireTransport(store).clearConversation(conversationId),
    ...curryOptional(store, conversationId),
  };
}

// The optional edit/branch/rewind methods, each present only when the
// transport implements it.
function curryOptional(
  store: ConversationStore,
  conversationId: string | null
): Partial<ConversationCommands> {
  const t = store.transport;
  if (!t) return {};
  const out: Partial<ConversationCommands> = {};
  if (t.selectVersion)
    out.selectVersion = (messageIndex, attempt) =>
      requireTransport(store).selectVersion!(
        conversationId,
        messageIndex,
        attempt
      );
  if (t.editResponse)
    out.editResponse = (messageIndex, text) =>
      requireTransport(store).editResponse!(conversationId, messageIndex, text);
  if (t.truncateToMessage)
    out.truncateToMessage = (messageIndex) =>
      requireTransport(store).truncateToMessage!(conversationId, messageIndex);
  if (t.restoreCheckpoint)
    out.restoreCheckpoint = (checkpoint) =>
      requireTransport(store).restoreCheckpoint!(conversationId, checkpoint);
  if (t.reloadHistory)
    out.reloadHistory = () =>
      requireTransport(store).reloadHistory!(conversationId);
  return out;
}

interface ConversationContextValue {
  store: ConversationStore;
  conversationId: string | null;
  commands: ConversationCommands;
}

const ConversationContext = createContext<ConversationContextValue | null>(
  null
);

export interface ConversationProviderProps {
  store: ConversationStore;
  conversationId: string | null;
  children?: ReactNode;
}

export function ConversationProvider({
  store,
  conversationId,
  children,
}: ConversationProviderProps): ReactElement {
  const commands = useMemo(
    () => createCommands(store, conversationId),
    [store, conversationId]
  );
  const value = useMemo(
    () => ({ store, conversationId, commands }),
    [store, conversationId, commands]
  );
  return createElement(ConversationContext, { value }, children);
}

function useProvider(): ConversationContextValue {
  const value = useContext(ConversationContext);
  if (!value)
    throw new Error(
      "Conversation hooks must be used inside ConversationProvider"
    );
  return value;
}

function useSlice<T>(
  store: ConversationStore,
  conversationId: string | null,
  key: SliceKey,
  read: (id: string) => T,
  empty: T
): T {
  const subscribe = useCallback(
    (listener: () => void) =>
      conversationId === null
        ? () => {}
        : store.subscribeSlice(conversationId, key, listener),
    [store, conversationId, key]
  );
  const getSnapshot = useCallback(
    () => (conversationId === null ? empty : read(conversationId)),
    [conversationId, empty, read]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface ActiveConversation
  extends ConversationOverview, ConversationCommands {}

export function useConversation(): ActiveConversation {
  const { store, conversationId, commands } = useProvider();
  const overview = useSlice(
    store,
    conversationId,
    "overview",
    (id) => store.getOverview(id),
    EMPTY_OVERVIEW
  );
  return useMemo<ActiveConversation>(
    () => ({ ...overview, ...commands }),
    [overview, commands]
  );
}

/** Messages sent mid-turn that have not reached the model yet. */
export function useQueuedMessages(): MessageQueueEntry[] {
  const { store, conversationId } = useProvider();
  return useSlice(
    store,
    conversationId,
    "queue",
    (id) => store.get(id).queuedMessages,
    INITIAL_STATE.queuedMessages
  );
}

export function useSegments(): Segment[] {
  const { store, conversationId } = useProvider();
  return useSlice(
    store,
    conversationId,
    "segments",
    (id) => store.getSegments(id),
    INITIAL_STATE.segments
  );
}

export interface PermissionHookResult {
  prompt: PermissionPrompt | null;
  respondToPermission: ConversationCommands["respondToPermission"];
}

export function usePermission(): PermissionHookResult {
  const { store, conversationId, commands } = useProvider();
  const prompt = useSlice(
    store,
    conversationId,
    "permission",
    (id) => store.get(id).pendingPermission,
    null
  );
  return useMemo(
    () => ({ prompt, respondToPermission: commands.respondToPermission }),
    [prompt, commands.respondToPermission]
  );
}

export function useConversationActivity(): ConversationActivity {
  const { store, conversationId } = useProvider();
  return useSlice(
    store,
    conversationId,
    "activity",
    (id) => store.getDerivations(id).activity,
    INITIAL_DERIVATIONS.activity
  );
}

/** Canonical plan state for the active conversation. */
export function useTodos(): TodoState {
  const { store, conversationId } = useProvider();
  return useSlice(
    store,
    conversationId,
    "todos",
    (id) => store.getDerivations(id).todos,
    INITIAL_DERIVATIONS.todos
  );
}

/** In transcript order. */
export function useSubtasks(): SubtaskSummary[] {
  const { store, conversationId } = useProvider();
  return useSlice(
    store,
    conversationId,
    "subtasks",
    (id) => store.getDerivations(id).subtasks,
    INITIAL_DERIVATIONS.subtasks
  );
}

export function useToolGroupDisclosure(groupId: string): {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
} {
  const { store, conversationId } = useProvider();
  const expanded = useSlice(
    store,
    conversationId,
    `group-ui:${groupId}`,
    (id) => store.isToolGroupExpanded(id, groupId),
    false
  );
  const setExpanded = useCallback(
    (next: boolean) => {
      if (conversationId !== null) {
        store.setToolGroupExpanded(conversationId, groupId, next);
      }
    },
    [conversationId, groupId, store]
  );
  return useMemo(() => ({ expanded, setExpanded }), [expanded, setExpanded]);
}
