import { create } from "zustand";

/**
 * Which thread the Code transcript is showing, per agent session.
 *
 * `null` (or absent) is the main agent; a subtask id scopes the transcript to
 * that sub-agent's own work. Shared state rather than panel-local, so the
 * Agents tab and the transcript stay in agreement about what's on screen.
 */
type SubtaskScopeStore = {
  scopeBySession: Record<string, string | null>;
  setScope: (sessionId: string, subtaskId: string | null) => void;
};

export const useSubtaskScopeStore = create<SubtaskScopeStore>((set) => ({
  scopeBySession: {},
  setScope: (sessionId, subtaskId) => {
    set((state) => ({
      scopeBySession: { ...state.scopeBySession, [sessionId]: subtaskId },
    }));
  },
}));

export const useSubtaskScope = (sessionId: string | null): string | null =>
  useSubtaskScopeStore((s) =>
    sessionId == null ? null : (s.scopeBySession[sessionId] ?? null)
  );
