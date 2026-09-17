import { createStore, useSelector } from "@tanstack/react-store";

import type {
  ConversationKey,
  DraftConversationKey,
  SessionConversationKey,
} from "#shared/conversation-scope";
import { conversationBelongsToWorkspace } from "#shared/conversation-scope";
import type { TerminalShellId } from "#shared/terminal-shells";

export type TerminalRuntimeTab = {
  id: string;
  label: string;
  generation: number | null;
  /**
   * The shell this tab runs. Absent until one has been spawned, which is what
   * a tab opened without a pick means: main resolves the stored preference,
   * and the answer comes back on the start result.
   */
  shell?: TerminalShellId;
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

const EMPTY_SCOPE: TerminalRuntimeScopeState = Object.freeze({
  isOpen: false,
  generation: null,
  tabs: Object.freeze([]),
  activeTabId: null,
});

export const terminalRuntimeStore = createStore<TerminalRuntimeState>({
  scopes: {},
});

let nextTerminalId = 1;

/**
 * Ids are never reused, including the first tab's.
 *
 * Main keys a PTY by conversation and terminal id, and hands a new terminal
 * the scrollback of whatever is already running under that id. While the
 * first tab was always `terminal-1`, closing every tab and opening the panel
 * again produced that id a second time — so the "new" terminal came up
 * attached to the old shell, showing everything the last one had printed.
 */
const createTerminalId = (): string => {
  nextTerminalId += 1;

  return `terminal-${Date.now().toString(36)}-${nextTerminalId.toString(36)}`;
};

const withDefaultTab = (
  current: TerminalRuntimeScopeState
): TerminalRuntimeScopeState => {
  if (current.tabs.length > 0) return current;
  const tab: TerminalRuntimeTab = {
    id: createTerminalId(),
    label: "Terminal 1",
    generation: null,
  };

  return {
    ...current,
    tabs: [tab],
    activeTabId: tab.id,
    generation: tab.generation,
  };
};

/**
 * An update that changes nothing writes nothing. Every component that reads a
 * scope re-renders on a store write, and the workspace view rebuilds the
 * conversation object it hands the panel on each render — so a write of an
 * identical value from inside an effect that reads it is an endless loop of
 * renders, PTY attaches and scrollback replays. Returning `current` unchanged
 * is how an action says "nothing happened".
 */
const updateScope = (
  scope: ConversationKey,
  update: (current: TerminalRuntimeScopeState) => TerminalRuntimeScopeState
): void => {
  terminalRuntimeStore.setState((state) => {
    const current = state.scopes[scope] ?? EMPTY_SCOPE;
    const next = update(current);
    if (next === current) return state;

    return { scopes: { ...state.scopes, [scope]: next } };
  });
};

export const terminalRuntimeActions = {
  setOpen: (scope: ConversationKey, isOpen: boolean): void =>
    updateScope(scope, (value) => ({
      ...(isOpen ? withDefaultTab(value) : value),
      isOpen,
    })),

  /**
   * `options.shell` is a deliberate pick from the `+` menu; without one the
   * tab opens whatever main has stored, so the panel opening a terminal by
   * itself never has to ask.
   */
  addTab: (
    scope: ConversationKey,
    options: { shell?: TerminalShellId; label?: string } = {}
  ): string => {
    const id = createTerminalId();
    updateScope(scope, (value) => {
      const current = withDefaultTab(value);
      const tab: TerminalRuntimeTab = {
        id,
        label: options.label ?? `Terminal ${current.tabs.length + 1}`,
        generation: null,
        shell: options.shell,
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

  /** What a start actually spawned, so a reopened tab asks for the same shell. */
  setTabShell: (
    scope: ConversationKey,
    terminalId: string,
    shell: TerminalShellId | undefined
  ): void =>
    updateScope(scope, (value) => {
      const tab = value.tabs.find(({ id }) => id === terminalId);
      if (tab == null || tab.shell === shell) return value;

      return {
        ...value,
        tabs: value.tabs.map((entry) =>
          entry.id === terminalId ? { ...entry, shell } : entry
        ),
      };
    }),

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
      const id = terminalId ?? current.activeTabId ?? current.tabs[0]?.id;
      if (id == null) return value;
      const tab = current.tabs.find((entry) => entry.id === id);
      const active =
        current.activeTabId === id ? generation : current.generation;
      // Same generation on the same tab: the caller is re-reporting what the
      // store already holds, and a new object here would re-render everything
      // that reads it.
      if (
        current === value &&
        tab?.generation === generation &&
        current.generation === active
      )
        return value;
      const tabs = current.tabs.map((entry) =>
        entry.id === id ? { ...entry, generation } : entry
      );
      return { ...current, tabs, generation: active };
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
