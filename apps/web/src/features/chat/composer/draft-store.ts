/**
 * Drafts per thread (spec 02 §8.7): text, attachments and the pre-start
 * mode/model, persisted to `sessionStorage` per document (kept across HMR
 * and route switches, lost on quit). Attachments in flight are not
 * persisted.
 */
import { Store } from "@tanstack/react-store";

import { bindContinuityStore } from "#renderer/lib/continuity/registry";
import type { AgentMode } from "@abacus-ai/contract/agent-types";

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

import type { SubmissionEnvelope } from "../runtime/admission";

export interface Draft {
  pendingSubmit?: SubmissionEnvelope;
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

// Kept independently of draft identity and content, including across clears.
const revisions = new Map<string, number>();
export const draftRevision = (threadId: string): number =>
  revisions.get(threadId) ?? 0;
const advance = (threadId: string): void => {
  revisions.set(threadId, draftRevision(threadId) + 1);
};

export const updateDraft = (
  threadId: string,
  update: (draft: Draft) => Draft
): void => {
  advance(threadId);
  draftStore.setState((state) => ({
    ...state,
    [threadId]: update(state[threadId] ?? EMPTY_DRAFT),
  }));
};

export const clearDraft = (
  threadId: string,
  keep: Partial<Draft> = {}
): void => {
  advance(threadId);
  draftStore.setState((state) => ({
    ...state,
    [threadId]: { ...EMPTY_DRAFT, ...keep },
  }));
};

export const restoreDraft = (
  threadId: string,
  revision: number,
  saved: Draft
): void => {
  if (draftRevision(threadId) === revision) updateDraft(threadId, () => saved);
};

/** Adopt a model using the key carried by `for=draft:<key>`. */
export const adoptDraftModel = (key: string, model: string | null): void => {
  updateDraft(key, (draft) => ({ ...draft, model }));
};

bindContinuityStore(KEY, {
  read: () => draftStore.state,
  write: (value) => draftStore.setState(() => value as Record<string, Draft>),
});

/** Import durable pre-cutover text before composers mount; current drafts win. */
export const importLegacyDrafts = async (
  legacy: Record<string, string>,
  acknowledge: (keys: string[]) => Promise<void>
): Promise<void> => {
  const keys = Object.keys(legacy);
  if (!keys.length) return;
  draftStore.setState((state) => ({
    ...Object.fromEntries(
      Object.entries(legacy).map(([key, text]) => [
        key,
        { text, attachments: [] },
      ])
    ),
    ...state,
  }));
  // Do not consume durable evidence when session storage is unavailable/full.
  globalThis.sessionStorage.setItem(KEY, JSON.stringify(draftStore.state));
  await acknowledge(keys);
};
