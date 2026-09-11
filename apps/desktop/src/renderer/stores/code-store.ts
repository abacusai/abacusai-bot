import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { AgentMode } from "#shared/agent-types";

import { durableStorage } from "../lib/durable-storage";

export type RightTabId = "explorer" | "agents" | "preview" | "device";
type CodeSidebarTab = "threads" | "workspaces";

/** Which of the two things the empty pane is being asked to make. */
export type NewPaneIntent = "bot" | "session";

type WorkspaceUiState = {
  activeSessionId: string | null;
};

type WorkspaceStore = {
  // The renderer's source of truth, updated synchronously by switch/add
  // handlers; metadata-updated reconciles a removed workspace but never
  // clobbers a renderer-driven switch.
  activeWorkspaceId: string | null;
  workspaceUiStates: Record<string, WorkspaceUiState>;
  /** sessionId -> workspaceId; a workspace must not pin another's session. */
  sessionWorkspaceMap: Record<string, string>;
  workspaceAccordionExpanded: Record<string, boolean>;
  /** Sessions that completed while not active. Not persisted. */
  backgroundCompletedSessionIds: string[];
  /** Deleted ids are harmless: nothing renders them. */
  pinnedSessionIds: string[];
  /** Its own list: the Bots section has its own Pinned group. */
  pinnedBotIds: string[];
  isSidebarVisible: boolean;
  isRightPanelVisible: boolean;
  activeRightTab: RightTabId | null;
  selectedModelId: string | null;
  favoriteModelIds: string[];
  globalSelectedMode: AgentMode;
  workspaceSelectedModelIds: Record<string, string | null>;
  codeSidebarTab: CodeSidebarTab;
  setCodeSidebarTab: (tab: CodeSidebarTab) => void;
  /** Set by the sidebar's two + buttons; the empty pane cannot tell them apart alone. */
  newPaneIntent: NewPaneIntent;
  setNewPaneIntent: (intent: NewPaneIntent) => void;
  deselectWorkspace: () => void;
  /**
   * Kept across launches so a new session opens on it. The app's own folders
   * (auto workspace, bot home) never land here: nobody chose them.
   */
  lastPickedWorkspaceId: string | null;
  setLastPickedWorkspaceId: (workspaceId: string | null) => void;
  /** Stops a metadata refresh handing a deselected slate back to main's workspace. */
  workspaceDeselected: boolean;
  selectedBrowserProfileId: string | null;
  setSelectedBrowserProfileId: (profileId: string | null) => void;
  activateWorkspaceSession: (
    workspaceId: string,
    sessionId: string | null
  ) => boolean;
  hydrateActiveWorkspaceFromMetadata: (
    metadataActiveId: string | null,
    validWorkspaceIds: string[]
  ) => void;
  registerSessionWorkspace: (sessionId: string, workspaceId: string) => void;
  unregisterSession: (sessionId: string) => void;
  reconcileSessionsForWorkspace: (
    workspaceId: string,
    sessionIds: string[]
  ) => void;
  getSessionWorkspaceId: (sessionId: string | null) => string | null;
  setSidebarVisible: (value: boolean) => void;
  setRightPanelVisible: (value: boolean) => void;
  setActiveRightTab: (tab: RightTabId | null) => void;
  setSelectedModelId: (modelId: string | null) => void;
  toggleFavoriteModel: (modelId: string) => void;
  setWorkspaceModelId: (workspaceId: string, modelId: string) => void;
  getSelectedModelId: (workspaceId: string | null) => string | null;
  setSelectedMode: (mode: AgentMode) => void;
  getSelectedMode: () => AgentMode;
  setActiveSessionId: (workspaceId: string, sessionId: string | null) => void;
  getActiveSessionId: (workspaceId: string | null) => string | null;
  setWorkspaceAccordionExpanded: (
    workspaceId: string,
    expanded: boolean
  ) => void;
  isWorkspaceAccordionExpanded: (workspaceId: string) => boolean;
  markSessionCompleted: (sessionId: string) => void;
  markSessionViewed: (sessionId: string) => void;
  isSessionCompletedInBackground: (sessionId: string) => boolean;
  toggleSessionPinned: (sessionId: string) => void;
  toggleBotPinned: (botId: string) => void;
  isBotPinned: (botId: string) => boolean;
  isSessionPinned: (sessionId: string) => boolean;
};

const STORE_KEY = "local-code-ui-store";

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      activeWorkspaceId: null,
      workspaceUiStates: {},
      sessionWorkspaceMap: {},
      workspaceAccordionExpanded: {},
      backgroundCompletedSessionIds: [],
      pinnedSessionIds: [],
      pinnedBotIds: [],
      isSidebarVisible: true,
      isRightPanelVisible: false,
      activeRightTab: null,
      selectedModelId: null,
      favoriteModelIds: [],
      // Full access by default: a permission prompt on every step is not what
      // this app is for. A stored choice wins over this.
      globalSelectedMode: AgentMode.Yolo,
      workspaceSelectedModelIds: {},
      codeSidebarTab: "workspaces",
      setCodeSidebarTab: (tab) => set({ codeSidebarTab: tab }),
      // Bots are the product, so an app opened cold asks for one.
      newPaneIntent: "bot",
      setNewPaneIntent: (intent) => set({ newPaneIntent: intent }),
      deselectWorkspace: () =>
        set((state) => {
          const current = state.activeWorkspaceId;
          // A re-selected workspace must not come back to the old chat.
          const workspaceUiStates =
            current == null
              ? state.workspaceUiStates
              : {
                  ...state.workspaceUiStates,
                  [current]: {
                    ...(state.workspaceUiStates[current] ?? {
                      activeSessionId: null,
                    }),
                    activeSessionId: null,
                  },
                };
          return {
            activeWorkspaceId: null,
            workspaceDeselected: true,
            workspaceUiStates,
          };
        }),
      workspaceDeselected: false,
      lastPickedWorkspaceId: null,
      setLastPickedWorkspaceId: (workspaceId) =>
        set({ lastPickedWorkspaceId: workspaceId }),
      selectedBrowserProfileId: null,
      setSelectedBrowserProfileId: (profileId) =>
        set({ selectedBrowserProfileId: profileId }),
      activateWorkspaceSession: (workspaceId, sessionId) => {
        const owner =
          sessionId == null ? undefined : get().sessionWorkspaceMap[sessionId];
        if (owner != null && owner !== workspaceId) {
          console.warn(
            `[code-store] refusing to activate sessionId=${sessionId} on workspace ${workspaceId}; owner is ${owner}`
          );
          return false;
        }

        // One atomic write, or the target workspace renders its previous (often
        // very large) transcript before the requested session is selected.
        set((state) => ({
          activeWorkspaceId: workspaceId,
          workspaceDeselected: false,
          workspaceUiStates: {
            ...state.workspaceUiStates,
            [workspaceId]: {
              ...(state.workspaceUiStates[workspaceId] ?? {
                activeSessionId: null,
              }),
              activeSessionId: sessionId,
            },
          },
          backgroundCompletedSessionIds:
            sessionId == null
              ? state.backgroundCompletedSessionIds
              : state.backgroundCompletedSessionIds.filter(
                  (id) => id !== sessionId
                ),
        }));
        return true;
      },
      hydrateActiveWorkspaceFromMetadata: (
        metadataActiveId,
        validWorkspaceIds
      ) => {
        const current = get().activeWorkspaceId;
        // No value yet: take main's choice, except after a deliberate deselect,
        // since the file watcher fires this on every change while a pane is open.
        if (current == null) {
          if (get().workspaceDeselected) return;
          if (metadataActiveId != null) {
            set({ activeWorkspaceId: metadataActiveId });
          }
          return;
        }
        // Removed workspace: fall back to main. Otherwise keep the renderer's
        // value so a stale refetch cannot revert a switch the user just made.
        if (!validWorkspaceIds.includes(current)) {
          if (metadataActiveId != null) {
            set({ activeWorkspaceId: metadataActiveId });
          } else {
            set({ activeWorkspaceId: null });
          }
        }
      },
      registerSessionWorkspace: (sessionId, workspaceId) => {
        set((state) => {
          if (state.sessionWorkspaceMap[sessionId] === workspaceId)
            return state;
          return {
            sessionWorkspaceMap: {
              ...state.sessionWorkspaceMap,
              [sessionId]: workspaceId,
            },
          };
        });
      },
      unregisterSession: (sessionId) => {
        set((state) => {
          if (!(sessionId in state.sessionWorkspaceMap)) return state;
          const next = { ...state.sessionWorkspaceMap };
          delete next[sessionId];
          const nextUi: Record<string, WorkspaceUiState> = {};
          for (const [wid, ui] of Object.entries(state.workspaceUiStates)) {
            nextUi[wid] =
              ui.activeSessionId === sessionId
                ? { ...ui, activeSessionId: null }
                : ui;
          }
          return { sessionWorkspaceMap: next, workspaceUiStates: nextUi };
        });
      },
      reconcileSessionsForWorkspace: (workspaceId, sessionIds) => {
        set((state) => {
          const next: Record<string, string> = { ...state.sessionWorkspaceMap };
          for (const sid of sessionIds) {
            if (next[sid] !== workspaceId) next[sid] = workspaceId;
          }
          // Drop this workspace's entries that left its session list.
          for (const [sid, wid] of Object.entries(next)) {
            if (wid === workspaceId && !sessionIds.includes(sid)) {
              delete next[sid];
            }
          }
          return { sessionWorkspaceMap: next };
        });
      },
      getSessionWorkspaceId: (sessionId) => {
        if (sessionId == null) return null;
        return get().sessionWorkspaceMap[sessionId] ?? null;
      },
      setSidebarVisible: (value) => set({ isSidebarVisible: value }),
      setRightPanelVisible: (value) => set({ isRightPanelVisible: value }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      setSelectedModelId: (modelId) => {
        const workspaceId = get().activeWorkspaceId;
        if (workspaceId == null) {
          set({ selectedModelId: modelId });
          return;
        }
        set((state) => ({
          selectedModelId: modelId,
          workspaceSelectedModelIds: {
            ...state.workspaceSelectedModelIds,
            [workspaceId]: modelId,
          },
        }));
      },
      toggleFavoriteModel: (modelId) => {
        set((state) => ({
          favoriteModelIds: state.favoriteModelIds.includes(modelId)
            ? state.favoriteModelIds.filter((id) => id !== modelId)
            : [...state.favoriteModelIds, modelId],
        }));
      },
      setWorkspaceModelId: (workspaceId, modelId) => {
        set((state) => ({
          selectedModelId: modelId,
          workspaceSelectedModelIds: {
            ...state.workspaceSelectedModelIds,
            [workspaceId]: modelId,
          },
        }));
      },
      getSelectedModelId: (workspaceId) => {
        if (workspaceId == null) {
          return get().selectedModelId;
        }
        return (
          get().workspaceSelectedModelIds[workspaceId] ?? get().selectedModelId
        );
      },
      // One value for every session: a per-workspace mode would override what
      // the picker showed on the new-session screen once a send resolves one.
      setSelectedMode: (mode) => set({ globalSelectedMode: mode }),
      getSelectedMode: () => get().globalSelectedMode,
      setActiveSessionId: (workspaceId, sessionId) => {
        // The cross-workspace boundary: dropping the write with a warning beats
        // a send in W2 landing in W1.
        if (sessionId != null) {
          const owner = get().sessionWorkspaceMap[sessionId];
          if (owner != null && owner !== workspaceId) {
            console.warn(
              `[code-store] refusing to set activeSessionId=${sessionId} on workspace ${workspaceId}; owner is ${owner}`
            );
            return;
          }
        }
        set((state) => ({
          workspaceUiStates: {
            ...state.workspaceUiStates,
            [workspaceId]: {
              ...(state.workspaceUiStates[workspaceId] ?? {
                activeSessionId: null,
              }),
              activeSessionId: sessionId,
            },
          },
        }));
      },
      getActiveSessionId: (workspaceId) => {
        if (workspaceId == null) {
          return null;
        }
        return get().workspaceUiStates[workspaceId]?.activeSessionId ?? null;
      },
      setWorkspaceAccordionExpanded: (workspaceId, expanded) => {
        set((state) => ({
          workspaceAccordionExpanded: {
            ...state.workspaceAccordionExpanded,
            [workspaceId]: expanded,
          },
        }));
      },
      isWorkspaceAccordionExpanded: (workspaceId) => {
        return get().workspaceAccordionExpanded[workspaceId] ?? true;
      },
      markSessionCompleted: (sessionId) => {
        set((state) => {
          if (state.backgroundCompletedSessionIds.includes(sessionId))
            return state;
          return {
            backgroundCompletedSessionIds: [
              ...state.backgroundCompletedSessionIds,
              sessionId,
            ],
          };
        });
      },
      markSessionViewed: (sessionId) => {
        set((state) => ({
          backgroundCompletedSessionIds:
            state.backgroundCompletedSessionIds.filter(
              (id) => id !== sessionId
            ),
        }));
      },
      isSessionCompletedInBackground: (sessionId) => {
        return get().backgroundCompletedSessionIds.includes(sessionId);
      },
      toggleSessionPinned: (sessionId) => {
        set((state) => ({
          pinnedSessionIds: state.pinnedSessionIds.includes(sessionId)
            ? state.pinnedSessionIds.filter((id) => id !== sessionId)
            : [...state.pinnedSessionIds, sessionId],
        }));
      },
      isSessionPinned: (sessionId) => {
        return get().pinnedSessionIds.includes(sessionId);
      },
      toggleBotPinned: (botId) => {
        set((state) => ({
          pinnedBotIds: state.pinnedBotIds.includes(botId)
            ? state.pinnedBotIds.filter((id) => id !== botId)
            : [...state.pinnedBotIds, botId],
        }));
      },
      isBotPinned: (botId) => {
        return get().pinnedBotIds.includes(botId);
      },
    }),
    {
      name: STORE_KEY,
      storage: createJSONStorage(() => durableStorage),
      // v3 stopped persisting the right pane (it belongs to the conversation on
      // screen); v4 dropped per-workspace modes.
      version: 4,
      migrate: (persistedState, version) => {
        if (persistedState == null) return persistedState;
        const state = persistedState as Partial<WorkspaceStore> & {
          isRightPanelVisible?: unknown;
          activeRightTab?: unknown;
          workspaceSelectedModes?: unknown;
        };
        if (version < 3) {
          delete state.isRightPanelVisible;
          delete state.activeRightTab;
        }
        // Only the global carries over; a per-workspace mode is not promoted.
        if (version < 4) delete state.workspaceSelectedModes;
        return state;
      },
      partialize: (state) => ({
        isSidebarVisible: state.isSidebarVisible,
        selectedModelId: state.selectedModelId,
        favoriteModelIds: state.favoriteModelIds,
        globalSelectedMode: state.globalSelectedMode,
        workspaceSelectedModelIds: state.workspaceSelectedModelIds,
        workspaceAccordionExpanded: state.workspaceAccordionExpanded,
        codeSidebarTab: state.codeSidebarTab,
        pinnedSessionIds: state.pinnedSessionIds,
        pinnedBotIds: state.pinnedBotIds,
        lastPickedWorkspaceId: state.lastPickedWorkspaceId,
      }),
    }
  )
);
