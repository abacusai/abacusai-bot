import type { UIMessage } from "@tanstack/ai-client";
import { Store } from "@tanstack/react-store";

import type { Db } from "#next/data/db";
import type { AppClient } from "#next/data/transport/types";
import type { AgentMode } from "#shared/agent-types";
import type { SessionRow } from "#shared/contract/rows";
import {
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
} from "#shared/conversation-scope";

import { promoteTabs } from "../dock/panel-tabs-store";
export interface SubmissionEnvelope {
  runId: string;
  messageId: string;
  parts: UIMessage["parts"];
  forwardedProps?: Record<string, unknown>;
}
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
}
const KEY = "abacus.sessions.start";
export const newStartDraft = (): StartDraft => ({
  id: crypto.randomUUID(),
  workspaceId: null,
  worktree: { kind: "current" },
  worktreeOperationId: null,
  stage: "draft",
  envelope: null,
});
const load = (): StartDraft => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "null") ?? newStartDraft();
  } catch {
    return newStartDraft();
  }
};
export const startDraftStore = new Store<StartDraft>(load());
startDraftStore.subscribe((s) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
});
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
  handoff(id: string, envelope: SubmissionEnvelope): void;
  navigate(id: string): Promise<unknown> | void;
}
const running = new WeakSet<Store<StartDraft>>();
export const startSession = async (
  deps: StartSessionDeps,
  envelope?: SubmissionEnvelope
): Promise<void> => {
  const store = deps.store ?? startDraftStore;
  if (running.has(store)) return;
  running.add(store);
  const patch = (value: Partial<StartDraft>) =>
    store.setState((s) => ({ ...s, ...value }));
  try {
    if (envelope) patch({ envelope });
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
          if ((error as { code?: string }).code !== "CONFLICT") throw error;
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
      const from = draftConversationKey(workspaceId);
      const to = sessionConversationKey(workspaceId, sessionId);
      const promotions = await Promise.allSettled([
        deps.client.terminal.promoteScope({
          draftConversationKey: from,
          draftConversation: draftConversationRef(workspaceId),
          sessionConversationKey: to,
          sessionConversation: sessionConversationRef(workspaceId, sessionId),
        }),
        deps.client.browser.runtime.promoteScope({
          draftConversationKey: from,
          sessionConversationKey: to,
        }),
      ]);
      for (const result of promotions)
        if (result.status === "rejected")
          console.warn("Scope promotion failed", result.reason);
      promoteTabs(from, to);
      patch({ stage: "checkout-ready" });
    }
    deps.handoff(sessionId, store.state.envelope!);
    patch({ stage: "handed-off" });
    await deps.navigate(sessionId);
    store.setState(() => newStartDraft());
  } finally {
    running.delete(store);
  }
};
