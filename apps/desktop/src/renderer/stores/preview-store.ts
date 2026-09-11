import {
  createStore,
  useSelector,
  type UseSelectorOptions,
} from "@tanstack/react-store";

import type {
  ConversationKey,
  DraftConversationKey,
  SessionConversationKey,
} from "#shared/conversation-scope";
import { conversationBelongsToWorkspace } from "#shared/conversation-scope";

type PreviewItemType =
  | "url"
  | "file"
  | "md"
  | "pptx"
  | "pdf"
  | "html"
  | "image";

export type PreviewItem = {
  type: PreviewItemType;
  location: string;
  title: string;
  /** When present, this is the item's tab id rather than type+location. */
  resourceId?: string;
  /**
   * Monotonic stamp set on every open, re-opens included, so viewers that
   * read the file themselves remount after the agent rewrote it.
   */
  openedAt?: number;
  fileContent?: string;
  fileAbsPath?: string;
  isEditing?: boolean;
  /** `fileContent` is only the head of the file; editing is off, a save would truncate it. */
  truncated?: boolean;
  /** Rendered documents (html, md) open rendered; this shows the source. */
  showSource?: boolean;
};

/**
 * What one conversation's preview tabs hold, keyed by conversation so a file
 * presented in one chat is never what another chat opens onto. Which tab is
 * on screen is not kept here: the right-panel store owns that for every kind
 * of tab, and a second owner was how a clicked tab got un-clicked.
 */
export type PreviewScopeState = {
  items: readonly PreviewItem[];
};

type PreviewState = {
  scopes: Readonly<Record<string, PreviewScopeState>>;
};

const MAX_ITEMS = 50;

const EMPTY_SCOPE: PreviewScopeState = Object.freeze({
  items: Object.freeze([]),
});

/** The right-panel tab an item lives in. */
export const previewTabId = (
  item: Pick<PreviewItem, "type" | "location" | "resourceId">
): string =>
  item.resourceId ?? `preview:${JSON.stringify([item.type, item.location])}`;

// Strictly increasing: two opens in the same millisecond must still differ.
let openCounter = 0;
const nextOpenedAt = (): number => {
  openCounter += 1;
  return openCounter;
};

export const createPreviewState = (): PreviewState => ({ scopes: {} });

export const previewStore = createStore<PreviewState>(createPreviewState());

const updateScope = (
  scope: ConversationKey,
  update: (current: PreviewScopeState) => PreviewScopeState
): void => {
  previewStore.setState((state) => {
    const current = state.scopes[scope] ?? EMPTY_SCOPE;
    const next = update(current);
    if (next === current) return state;
    return { scopes: { ...state.scopes, [scope]: next } };
  });
};

export const selectPreviewScope = (
  state: PreviewState,
  scope: ConversationKey | null
): PreviewScopeState =>
  scope == null ? EMPTY_SCOPE : (state.scopes[scope] ?? EMPTY_SCOPE);

export const selectPreviewItem = (
  state: PreviewState,
  scope: ConversationKey | null,
  tabId: string | null
): PreviewItem | null =>
  tabId == null
    ? null
    : (selectPreviewScope(state, scope).items.find(
        (item) => previewTabId(item) === tabId
      ) ?? null);

export const previewActions = {
  /**
   * Put an item in a conversation's tabs, replacing one already there under
   * the same id. Returns the tab id, plus the ids of the oldest items pushed
   * out by the cap so their tabs can go too.
   */
  open: (
    scope: ConversationKey,
    item: PreviewItem
  ): { id: string; dropped: string[] } => {
    const id = previewTabId(item);
    const dropped: string[] = [];
    updateScope(scope, (state) => {
      const stamped: PreviewItem = { ...item, openedAt: nextOpenedAt() };
      const existingIndex = state.items.findIndex(
        (entry) => previewTabId(entry) === id
      );
      if (existingIndex >= 0) {
        // Re-opening is not a no-op: the agent rewrites a file and previews
        // it again. Replace in place, keeping the rendered/source choice.
        const items = [...state.items];
        const previous = items[existingIndex]!;
        items[existingIndex] = {
          ...stamped,
          showSource: previous.showSource ?? stamped.showSource,
        };
        return { items };
      }
      let items = [...state.items, stamped];
      if (items.length > MAX_ITEMS) {
        for (const gone of items.slice(0, items.length - MAX_ITEMS))
          dropped.push(previewTabId(gone));
        items = items.slice(items.length - MAX_ITEMS);
      }
      return { items };
    });
    return { id, dropped };
  },

  /** Drop an item by tab id; a tab that is not a preview is left alone. */
  close: (scope: ConversationKey, tabId: string): void =>
    updateScope(scope, (state) => {
      const items = state.items.filter((item) => previewTabId(item) !== tabId);
      return items.length === state.items.length ? state : { items };
    }),

  clear: (scope: ConversationKey): void =>
    updateScope(scope, () => EMPTY_SCOPE),

  promoteDraft: (
    from: DraftConversationKey,
    to: SessionConversationKey
  ): void => {
    previewStore.setState((state) => {
      const draft = state.scopes[from];
      if (draft == null) return state;
      const { [from]: _removed, ...scopes } = state.scopes;
      return { scopes: { ...scopes, [to]: draft } };
    });
  },

  disposeScope: (scope: ConversationKey): void => {
    previewStore.setState((state) => {
      if (!(scope in state.scopes)) return state;
      const { [scope]: _removed, ...scopes } = state.scopes;
      return { scopes };
    });
  },

  disposeWorkspace: (workspaceId: string): void => {
    previewStore.setState((state) => ({
      scopes: Object.fromEntries(
        Object.entries(state.scopes).filter(
          ([scope]) =>
            !conversationBelongsToWorkspace(
              scope as ConversationKey,
              workspaceId
            )
        )
      ),
    }));
  },

  reset: (): void => previewStore.setState(() => createPreviewState()),
} as const;

export const usePreviewScopeSelector = <Selected>(
  scope: ConversationKey | null,
  selector: (state: PreviewScopeState) => Selected,
  options?: UseSelectorOptions<Selected>
): Selected =>
  useSelector(
    previewStore,
    (state) => selector(selectPreviewScope(state, scope)),
    options
  );

/** The item behind one of a conversation's tabs, or null when it has none. */
export const usePreviewItem = (
  scope: ConversationKey | null,
  tabId: string | null
): PreviewItem | null =>
  useSelector(previewStore, (state) => selectPreviewItem(state, scope, tabId));
