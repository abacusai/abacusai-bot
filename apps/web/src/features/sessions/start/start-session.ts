import type { AgentMode } from "@abacus-ai/contract/agent-types";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import { Store } from "@tanstack/react-store";

import type { Db } from "#renderer/data/db";
import { isRpcError } from "#renderer/data/query-client";
import type { AppClient } from "#renderer/data/transport/types";
import { updateDraft } from "#renderer/features/chat/composer/draft-store";
import type { SubmissionEnvelope } from "#renderer/features/chat/runtime/admission";
import { persistedStore } from "#renderer/lib/continuity/registry";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { promoteTabs } from "../dock/panel-tabs-store";
import {
  hasDraftContent,
  saveSessionDraft,
  restoreSessionDraft,
  removeSessionDraft,
  sessionDraftsStore,
} from "./session-drafts";
export type { SubmissionEnvelope } from "#renderer/features/chat/runtime/admission";
export interface StartDraft {
  id: string;
  workspaceId: string | null;
  worktree:
    | { kind: "current" }
    | { kind: "existing"; id: string }
    | { kind: "new"; baseRef: string };
  worktreeOperationId: string | null;
  stage: "draft" | "created" | "checkout-ready" | "handed-off";
  envelope: SubmissionEnvelope | null;
  submittedAt?: number;
}
export const newStartDraft = (): StartDraft => ({
  id: crypto.randomUUID(),
  workspaceId: null,
  worktree: { kind: "current" },
  worktreeOperationId: null,
  stage: "draft",
  envelope: null,
});
export const startDraftStore = persistedStore<StartDraft>(
  "abacusai-bot:abacus.sessions.start",
  newStartDraft
);
const savedActiveId = sessionDraftsStore.state.activeId;
const restored = savedActiveId ? restoreSessionDraft(savedActiveId) : undefined;
if (restored) startDraftStore.setState(() => restored);
else if (savedActiveId) startDraftStore.setState(newStartDraft);
saveSessionDraft(startDraftStore.state, true);
const subscription = startDraftStore.subscribe((draft) =>
  saveSessionDraft(draft, true)
);
import.meta.hot?.dispose(() => subscription.unsubscribe());

export const openStartDraft = (id?: string, workspaceId?: string): string => {
  const current = startDraftStore.state;
  const saved = id ? restoreSessionDraft(id) : undefined;
  if (saved) startDraftStore.setState(() => saved);
  else if (
    id ||
    current.envelope ||
    hasDraftContent(
      sessionDraftsStore.state.drafts[current.id]?.composer ?? {
        text: "",
        attachments: [],
      }
    )
  )
    startDraftStore.setState(() => ({
      ...newStartDraft(),
      workspaceId: workspaceId ?? null,
    }));
  else if (workspaceId)
    startDraftStore.setState((d) => ({ ...d, workspaceId }));
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLTextAreaElement>("[data-slot=composer] textarea")
      ?.focus()
  );
  return startDraftStore.state.id;
};

export const optimisticSession = (draft: StartDraft): SessionRow => {
  const now = new Date().toISOString();
  const picks = draft.envelope?.forwardedProps;
  return {
    id: draft.id,
    workspaceId: draft.workspaceId!,
    label: "",
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    status: "stopped",
    agentStatus: "idle" as SessionRow["agentStatus"],
    model: (picks?.model as string | null) ?? null,
    mode: (picks?.mode as AgentMode | null) ?? null,
    worktreeId: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeOperationId: null,
    routineId: null,
    runOutcome: null,
    runTrigger: null,
    editorFor: null,
    botOwned: false,
    owner: null,
    turn: null,
  };
};
export interface StartSessionDeps {
  db: Db;
  client: AppClient;
  store?: Store<StartDraft>;
  handoff(id: string, envelope: SubmissionEnvelope): Promise<void> | void;
  navigate(id: string): Promise<unknown> | void;
}
const sendingDrafts = new Map<string, Store<StartDraft>>();
export const rejectStartSubmission = (id: string): void => {
  const store = sendingDrafts.get(id);
  if (store) store.setState((d) => ({ ...d, envelope: null }));
  else if (startDraftStore.state.id === id)
    startDraftStore.setState((d) => ({ ...d, envelope: null }));
};
const running = new WeakMap<Store<StartDraft>, Promise<void>>();
const navigating = new WeakMap<Store<StartDraft>, number>();
export const prepareStartDraft = (db: Db, workspaceId: string | null): void => {
  const draft = startDraftStore.state;
  if (!draft.envelope) return;
  const row = db.collections.sessions.get(draft.id);
  const workspace = draft.workspaceId
    ? db.collections.workspaces.get(draft.workspaceId)
    : null;
  const submittedAt = draft.submittedAt ?? null;
  const obsolete =
    !workspace ||
    workspace.status === "deleted" ||
    (draft.stage !== "draft" && !row) ||
    submittedAt === null ||
    Date.now() - submittedAt > 24 * 60 * 60 * 1000;
  const next = obsolete ? { ...newStartDraft(), workspaceId } : draft;
  const text = draft.envelope.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n");
  updateDraft(`draft:${next.id}`, (current) => ({ ...current, text }));
  if (obsolete) startDraftStore.setState(() => next);
};
export const startSession = async (
  deps: StartSessionDeps,
  envelope?: SubmissionEnvelope
): Promise<void> => {
  const managed = deps.store === undefined;
  const id = startDraftStore.state.id;
  const store =
    deps.store ?? sendingDrafts.get(id) ?? new Store(startDraftStore.state);
  if (managed && !sendingDrafts.has(id)) {
    sendingDrafts.set(id, store);
    store.subscribe((draft) => {
      saveSessionDraft(draft);
      if (startDraftStore.state.id === draft.id)
        startDraftStore.setState(() => draft);
    });
  }
  const sessionId = store.state.id;
  let task = running.get(store);
  if (!task) {
    task = runStartSession({ ...deps, store }, envelope).finally(() =>
      running.delete(store)
    );
    running.set(store, task);
  }
  navigating.set(store, (navigating.get(store) ?? 0) + 1);
  try {
    await task;
    if (!managed || startDraftStore.state.id === sessionId)
      await deps.navigate(sessionId);
    if (navigating.get(store) === 1) {
      if (managed) {
        removeSessionDraft(sessionId);
        sendingDrafts.delete(sessionId);
        if (startDraftStore.state.id === sessionId)
          startDraftStore.setState(newStartDraft);
      } else if (store.state.id === sessionId) store.setState(newStartDraft);
    }
  } finally {
    const remaining = (navigating.get(store) ?? 1) - 1;
    if (remaining) navigating.set(store, remaining);
    else navigating.delete(store);
  }
};

const runStartSession = async (
  deps: StartSessionDeps,
  envelope?: SubmissionEnvelope
): Promise<void> => {
  const store = deps.store ?? startDraftStore;
  const patch = (value: Partial<StartDraft>) =>
    store.setState((s) => ({ ...s, ...value }));
  if (envelope)
    patch({
      envelope: store.state.envelope
        ? {
            ...envelope,
            runId: store.state.envelope.runId,
            messageId: store.state.envelope.messageId,
          }
        : envelope,
      submittedAt: store.state.submittedAt ?? Date.now(),
    });
  let draft = store.state;
  if (!draft.workspaceId || !draft.envelope)
    throw new Error("Missing workspace or submission");
  const workspaceId = draft.workspaceId;
  const sessionId = draft.id;
  if (draft.stage === "draft") {
    await deps.db.collections.sessions.preload();
    const existing = deps.db.collections.sessions.get(sessionId);
    if (existing && existing.workspaceId !== workspaceId)
      throw new Error("Session identity belongs to another workspace");
    if (!existing) {
      try {
        await deps.db.collections.sessions.insert(optimisticSession(draft))
          .isPersisted.promise;
      } catch (error) {
        if (!isRpcError(error) || error.code !== "CONFLICT") throw error;
        await deps.db.collections.sessions.utils.resync();
        if (
          deps.db.collections.sessions.get(sessionId)?.workspaceId !==
          workspaceId
        )
          throw error;
      }
    }
    patch({ stage: "created" });
  }
  draft = store.state;
  if (draft.stage === "created") {
    const row = deps.db.collections.sessions.get(sessionId);
    const ctx = { workspaceId, sessionId };
    if (draft.worktree.kind === "new") {
      if (!draft.worktreeOperationId)
        patch({ worktreeOperationId: crypto.randomUUID() });
      if (row?.worktreeOperationId !== store.state.worktreeOperationId) {
        const result = await deps.client.git.worktrees.materialize({
          ...ctx,
          baseRef: draft.worktree.baseRef,
          operationId: store.state.worktreeOperationId!,
        });
        if (!result.success)
          throw new Error(result.error ?? "Couldn't create worktree");
      }
    } else {
      const desired =
        draft.worktree.kind === "existing" ? draft.worktree.id : null;
      if (row?.worktreeId !== desired || desired === null) {
        const result = await deps.client.git.worktrees.setForSession({
          ...ctx,
          worktreeId: desired,
        });
        if (!result.success)
          throw new Error(result.error ?? "Couldn't attach checkout");
      }
    }
    const from = draftConversationKey(workspaceId, sessionId);
    const to = sessionConversationKey(workspaceId, sessionId);
    const promotions = await Promise.allSettled([
      deps.client.terminal.promoteScope({
        draftConversationKey: from,
        draftConversation: draftConversationRef(workspaceId, sessionId),
        sessionConversationKey: to,
        sessionConversation: sessionConversationRef(workspaceId, sessionId),
      }),
      IS_ELECTRON
        ? deps.client.browser.runtime.promoteScope({
            draftConversationKey: from,
            sessionConversationKey: to,
          })
        : Promise.resolve(),
    ]);
    for (const result of promotions)
      if (result.status === "rejected")
        console.warn("Scope promotion failed", result.reason);
    promoteTabs(from, to);
    patch({ stage: "checkout-ready" });
  }
  await deps.handoff(sessionId, store.state.envelope!);
  patch({ stage: "handed-off" });
};
