import {
  draftStore,
  EMPTY_DRAFT,
  updateDraft,
  type Draft,
} from "#renderer/features/chat/composer/draft-store";
import { persistedStore } from "#renderer/lib/continuity/registry";

import type { StartDraft } from "./start-session";

export interface SessionDraft extends StartDraft {
  createdAt: number;
  updatedAt: number;
  composer: Draft;
}
interface SessionDrafts {
  activeId: string | null;
  drafts: Record<string, SessionDraft>;
}
export const DRAFT_TTL = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_LIMIT = 20;
export const hasDraftContent = (draft: Draft): boolean =>
  draft.text.trim().length > 0 ||
  draft.attachments.length > 0 ||
  !!draft.replyTo;

export const pruneSessionDrafts = (
  state: SessionDrafts,
  now = Date.now()
): SessionDrafts => {
  const kept = Object.values(state.drafts).filter(
    (d) =>
      d.id === state.activeId || d.envelope || now - d.updatedAt < DRAFT_TTL
  );
  const oldest = kept
    .filter((d) => d.id !== state.activeId && !d.envelope)
    .sort(
      (a, b) =>
        Number(hasDraftContent(a.composer)) -
          Number(hasDraftContent(b.composer)) || a.updatedAt - b.updatedAt
    );
  const removed = new Set(
    oldest.slice(0, Math.max(0, kept.length - DRAFT_LIMIT)).map((d) => d.id)
  );
  return {
    ...state,
    drafts: Object.fromEntries(
      kept.filter((d) => !removed.has(d.id)).map((d) => [d.id, d])
    ),
  };
};

export const sessionDraftsStore = persistedStore<SessionDrafts>(
  "abacusai-bot:abacus.sessions.drafts",
  () => ({ activeId: null, drafts: {} }),
  {
    durable: true,
    batchMs: 250,
    urgent: (previous, next) =>
      previous.activeId !== next.activeId ||
      Object.keys(previous.drafts).length !== Object.keys(next.drafts).length ||
      Object.values(next.drafts).some(
        (d) => previous.drafts[d.id]?.envelope !== d.envelope
      ),
    serialize: (state) => ({
      ...state,
      drafts: Object.fromEntries(
        Object.entries(state.drafts).map(([id, d]) => [
          id,
          {
            ...d,
            composer: {
              ...d.composer,
              attachments: d.composer.attachments.map(
                ({ preview: _preview, ...a }) => ({
                  ...a,
                  ...(a.state === "uploading"
                    ? {
                        state: "error",
                        error: "Upload interrupted. Attach the file again.",
                      }
                    : {}),
                })
              ),
            },
          },
        ])
      ),
    }),
  }
);

export const saveSessionDraft = (draft: StartDraft, active = false): void => {
  const now = Date.now();
  sessionDraftsStore.setState((state) =>
    pruneSessionDrafts({
      activeId: active ? draft.id : state.activeId,
      drafts: {
        ...state.drafts,
        [draft.id]: {
          ...draft,
          createdAt: state.drafts[draft.id]?.createdAt ?? now,
          updatedAt: now,
          composer:
            draftStore.state[`draft:${draft.id}`] ??
            state.drafts[draft.id]?.composer ??
            EMPTY_DRAFT,
        },
      },
    })
  );
};

export const restoreSessionDraft = (id: string): SessionDraft | undefined => {
  const draft = sessionDraftsStore.state.drafts[id];
  if (!draft) return;
  updateDraft(`draft:${id}`, () => draft.composer);
  return draft;
};

export const removeSessionDraft = (id: string): (() => boolean) => {
  const saved = sessionDraftsStore.state.drafts[id];
  const deadline = Date.now() + 6000;
  sessionDraftsStore.setState((state) => ({
    ...state,
    activeId: state.activeId === id ? null : state.activeId,
    drafts: Object.fromEntries(
      Object.entries(state.drafts).filter(([key]) => key !== id)
    ),
  }));
  draftStore.setState((state) =>
    Object.fromEntries(
      Object.entries(state).filter(([key]) => key !== `draft:${id}`)
    )
  );
  let undone = false;
  return () => {
    if (
      !saved ||
      undone ||
      Date.now() > deadline ||
      sessionDraftsStore.state.drafts[id]
    )
      return false;
    undone = true;
    updateDraft(`draft:${id}`, () => saved.composer);
    sessionDraftsStore.setState((state) =>
      pruneSessionDrafts({ ...state, drafts: { ...state.drafts, [id]: saved } })
    );
    return true;
  };
};

const subscription = draftStore.subscribe((next) => {
  sessionDraftsStore.setState((state) => {
    let changed = false;
    const drafts = { ...state.drafts };
    for (const [id, draft] of Object.entries(drafts)) {
      const composer = next[`draft:${id}`];
      if (composer && composer !== draft.composer) {
        changed = true;
        drafts[id] = { ...draft, composer, updatedAt: Date.now() };
      }
    }
    return changed ? pruneSessionDrafts({ ...state, drafts }) : state;
  });
});
import.meta.hot?.dispose(() => {
  subscription.unsubscribe();
  sessionDraftsStore.dispose();
});
