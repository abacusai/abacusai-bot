/**
 * Drafts per thread (spec 02 §8.7): text, attachments and the pre-start
 * mode/model, persisted to `sessionStorage` per document (kept across HMR
 * and route switches, lost on quit). Attachments in flight are not
 * persisted.
 */
import { Store } from "@tanstack/react-store";

import type { AgentMode } from "#shared/agent-types";

export interface DraftAttachment {
  id: string;
  name: string;
  path: string | null;
  state: "uploading" | "done" | "error";
  size?: number;
  mimeType?: string;
  error?: string;
  /** Object URL of a pasted image, revoked on removal. */
  preview?: string;
}

export interface Draft {
  text: string;
  attachments: DraftAttachment[];
  mode?: AgentMode;
  model?: string | null;
}

const KEY = "abacus.chat.drafts";

const load = (): Record<string, Draft> => {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    return raw == null ? {} : (JSON.parse(raw) as Record<string, Draft>);
  } catch {
    return {};
  }
};

export const draftStore = new Store<Record<string, Draft>>(load());

draftStore.subscribe((state) => {
  try {
    const persisted = Object.fromEntries(
      Object.entries(state).map(([id, draft]) => [
        id,
        {
          ...draft,
          attachments: draft.attachments
            .filter((a) => a.state === "done")
            .map(({ preview: _preview, ...rest }) => rest),
        },
      ])
    );
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(persisted));
  } catch {
    // Storage full or unavailable: the draft lives in memory only.
  }
});

export const EMPTY_DRAFT: Draft = { text: "", attachments: [] };

export const updateDraft = (
  threadId: string,
  update: (draft: Draft) => Draft
): void =>
  draftStore.setState((state) => ({
    ...state,
    [threadId]: update(state[threadId] ?? EMPTY_DRAFT),
  }));

export const clearDraft = (threadId: string, keep: Partial<Draft> = {}): void =>
  draftStore.setState((state) => ({
    ...state,
    [threadId]: { ...EMPTY_DRAFT, ...keep },
  }));
