import { create } from "zustand";

import type { AgentSessionListItem } from "#shared/contracts";

import { forgetTranscript } from "../conversation/persistence";
import { workspaceConversationStore } from "../conversation/store";
import { workspaceConversationTransport } from "../conversation/transport";

// A message sent before its session exists, so the view can replace the
// welcome screen before createAgentSession resolves.
type PendingNewSession = {
  message: string;
  segmentId: string;
};

// Session-list and pending-send bookkeeping only; the transcript lives in the
// shared conversation store.
type AgentSessionStore = {
  pendingNewSessionByWorkspace: Record<string, PendingNewSession | null>;
  /** Populated from TanStack Query; kept for existing readers. */
  sessionsByWorkspace: Record<string, AgentSessionListItem[]>;
  clearSessionRuntime: (sessionId: string) => void;
  setPendingNewSession: (
    workspaceId: string,
    payload: PendingNewSession | null
  ) => void;
  setSessions: (workspaceId: string, sessions: AgentSessionListItem[]) => void;
  removeSessionListItem: (workspaceId: string, sessionId: string) => void;
};

export const useAgentSessionStore = create<AgentSessionStore>((set) => ({
  pendingNewSessionByWorkspace: {},
  sessionsByWorkspace: {},
  setSessions: (workspaceId, sessions) => {
    set((state) => ({
      sessionsByWorkspace: {
        ...state.sessionsByWorkspace,
        [workspaceId]: sessions,
      },
    }));
  },
  removeSessionListItem: (workspaceId, sessionId) => {
    set((state) => {
      const existing = state.sessionsByWorkspace[workspaceId] ?? [];
      return {
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [workspaceId]: existing.filter((s) => s.id !== sessionId),
        },
      };
    });
  },
  clearSessionRuntime: (sessionId) => {
    workspaceConversationStore.remove(sessionId);
    workspaceConversationTransport.forgetSession(sessionId);
    forgetTranscript(sessionId);
  },
  setPendingNewSession: (workspaceId, payload) => {
    set((store) => ({
      pendingNewSessionByWorkspace: {
        ...store.pendingNewSessionByWorkspace,
        [workspaceId]: payload,
      },
    }));
  },
}));
