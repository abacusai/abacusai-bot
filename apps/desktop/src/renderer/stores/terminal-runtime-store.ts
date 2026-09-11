import { createStore, useSelector } from "@tanstack/react-store";

import type {
  ConversationKey,
  DraftConversationKey,
  SessionConversationKey,
} from "#shared/conversation-scope";
import { conversationBelongsToWorkspace } from "#shared/conversation-scope";

export type TerminalRuntimeTab = {
  id: string;
  label: string;
  generation: number | null;
};

export type TerminalRuntimeScopeState = {
  isOpen: boolean;
  /** Generation of the active tab, retained for scope-promotion callers. */
  generation: number | null;
  tabs: readonly TerminalRuntimeTab[];
  activeTabId: string | null;
};

type TerminalRuntimeState = {
  scopes: Readonly<Record<string, TerminalRuntimeScopeState>>;
};

const DEFAULT_TAB: TerminalRuntimeTab = Object.freeze({
  id: "terminal-1",
  label: "Terminal 1",
  generation: null,
});

const EMPTY_SCOPE: TerminalRuntimeScopeState = Object.freeze({
  isOpen: false,
  generation: null,
  tabs: Object.freeze([]),
  activeTabId: null,
});

export const terminalRuntimeStore = createStore<TerminalRuntimeState>({
  scopes: {},
});

const withDefaultTab = (
  current: TerminalRuntimeScopeState
): TerminalRuntimeScopeState =>
  current.tabs.length > 0
    ? current
    : {
        ...current,
        tabs: [DEFAULT_TAB],
        activeTabId: DEFAULT_TAB.id,
        generation: DEFAULT_TAB.generation,
      };

const updateScope = (
  scope: ConversationKey,
  update: (current: TerminalRuntimeScopeState) => TerminalRuntimeScopeState
): void => {
  terminalRuntimeStore.setState((state) => ({
    scopes: {
      ...state.scopes,
      [scope]: update(state.scopes[scope] ?? EMPTY_SCOPE),
    },
  }));
};

let nextTerminalId = 1;
const createTerminalId = (): string => {
  nextTerminalId += 1;
  return `terminal-${Date.now().toString(36)}-${nextTerminalId.toString(36)}`;
};

export const terminalRuntimeActions = {
  setOpen: (scope: ConversationKey, isOpen: boolean): void =>
    updateScope(scope, (value) => ({
      ...(isOpen ? withDefaultTab(value) : value),
      isOpen,
    })),

  addTab: (scope: ConversationKey): string => {
    const id = createTerminalId();
    updateScope(scope, (value) => {
      const current = withDefaultTab(value);
      const tab: TerminalRuntimeTab = {
        id,
        label: `Terminal ${current.tabs.length + 1}`,
        generation: null,
      };
      return {
        ...current,
        isOpen: true,
        tabs: [...current.tabs, tab],
        activeTabId: id,
        generation: null,
      };
    });
    return id;
  },

  selectTab: (scope: ConversationKey, terminalId: string): void =>
    updateScope(scope, (value) => {
      const tab = value.tabs.find(({ id }) => id === terminalId);
      return tab == null
        ? value
        : {
            ...value,
            activeTabId: tab.id,
            generation: tab.generation,
          };
    }),

  closeTab: (scope: ConversationKey, terminalId: string): void =>
    updateScope(scope, (value) => {
      const index = value.tabs.findIndex(({ id }) => id === terminalId);
      if (index < 0) return value;
      const tabs = value.tabs.filter(({ id }) => id !== terminalId);
      if (tabs.length === 0) {
        return {
          isOpen: false,
          generation: null,
          tabs: [],
          activeTabId: null,
        };
      }
      const active =
        value.activeTabId === terminalId
          ? tabs[Math.min(index, tabs.length - 1)]!
          : (tabs.find(({ id }) => id === value.activeTabId) ?? tabs[0]!);
      return {
        ...value,
        tabs,
        activeTabId: active.id,
        generation: active.generation,
      };
    }),

  setGeneration: (
    scope: ConversationKey,
    generation: number | null,
    terminalId?: string
  ): void =>
    updateScope(scope, (value) => {
      const current = withDefaultTab(value);
      const id = terminalId ?? current.activeTabId ?? DEFAULT_TAB.id;
      const tabs = current.tabs.map((tab) =>
        tab.id === id ? { ...tab, generation } : tab
      );
      return {
        ...current,
        tabs,
        generation:
          current.activeTabId === id ? generation : current.generation,
      };
    }),

  promoteDraft: (
    from: DraftConversationKey,
    to: SessionConversationKey
  ): void => {
    terminalRuntimeStore.setState((state) => {
      const draft = state.scopes[from];
      if (draft == null) return state;
      const { [from]: _removed, ...scopes } = state.scopes;
      return {
        scopes: {
          ...scopes,
          [to]: {
            ...draft,
            generation: null,
            tabs: draft.tabs.map((tab) => ({ ...tab, generation: null })),
          },
        },
      };
    });
  },

  disposeScope: (scope: ConversationKey): void => {
    terminalRuntimeStore.setState((state) => {
      if (!(scope in state.scopes)) return state;
      const { [scope]: _removed, ...scopes } = state.scopes;
      return { scopes };
    });
  },

  disposeWorkspace: (workspaceId: string): void => {
    terminalRuntimeStore.setState((state) => ({
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

  reset: (): void => terminalRuntimeStore.setState(() => ({ scopes: {} })),
} as const;

export const useTerminalRuntimeScope = (
  scope: ConversationKey | null
): TerminalRuntimeScopeState =>
  useSelector(terminalRuntimeStore, (state) =>
    scope == null ? EMPTY_SCOPE : (state.scopes[scope] ?? EMPTY_SCOPE)
  );
