import { create } from "zustand";

import type { SkillMetadata } from "#shared/agent-types";

// Skills for the slash-command picker: the CLI's live per-session list once a
// process exists, over a disk-scanned baseline so an empty chat still has one.
interface SessionSkillsState {
  skillsBySession: Record<string, SkillMetadata[]>;
  baselineSkills: SkillMetadata[];
  /** Bumped by the Skills dialog after install/import/remove so the panel
   *  re-scans disk and refreshes the baseline without restarting a session. */
  refreshNonce: number;
  setSkills: (sessionId: string, skills: SkillMetadata[]) => void;
  setBaselineSkills: (skills: SkillMetadata[]) => void;
  clearSkills: (sessionId: string) => void;
  bumpRefresh: () => void;
}

const EMPTY: SkillMetadata[] = [];

// Compare every displayed field, not just id, so an edited description still
// updates the picker while an identical re-scan skips the re-render.
function sameSkills(
  a: SkillMetadata[] | undefined,
  b: SkillMetadata[]
): boolean {
  return (
    a != null &&
    a.length === b.length &&
    a.every((s, i) => {
      const next = b[i];
      return (
        next != null &&
        s.id === next.id &&
        s.name === next.name &&
        s.description === next.description &&
        s.location === next.location
      );
    })
  );
}

export const useSessionSkillsStore = create<SessionSkillsState>((set) => ({
  skillsBySession: {},
  baselineSkills: EMPTY,
  refreshNonce: 0,
  setSkills: (sessionId, skills) =>
    set((state) => {
      if (sameSkills(state.skillsBySession[sessionId], skills)) return state;
      return {
        skillsBySession: { ...state.skillsBySession, [sessionId]: skills },
      };
    }),
  setBaselineSkills: (skills) =>
    set((state) =>
      sameSkills(state.baselineSkills, skills)
        ? state
        : { baselineSkills: skills }
    ),
  clearSkills: (sessionId) =>
    set((state) => {
      if (state.skillsBySession[sessionId] == null) return state;
      const next = { ...state.skillsBySession };
      delete next[sessionId];
      return { skillsBySession: next };
    }),
  bumpRefresh: () => set((state) => ({ refreshNonce: state.refreshNonce + 1 })),
}));

/** The active session's live skills, else the disk-scanned baseline. */
export const useSessionSkills = (sessionId: string | null): SkillMetadata[] =>
  useSessionSkillsStore((s) => {
    const sess = sessionId != null ? s.skillsBySession[sessionId] : undefined;
    return sess != null && sess.length > 0 ? sess : s.baselineSkills;
  });
