/**
 * Continue a chat in a new one on another model: the old chat's agent writes
 * a summary of it on a low-cost model, and a new chat opens in the same
 * folder and checkout, on that model, with the summary waiting to go hidden
 * on its first message (main's continuation note). The old chat keeps its
 * history and its model. With `prompt`, the new chat sends it at once (the
 * retry under a stuck task); without, it waits for the user's words.
 */
import type { SessionRow } from "@abacus-ai/contract/contract/rows";

import type { AppClient } from "#renderer/data/transport/types";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";

import {
  newStartDraft,
  queueStartPrompt,
  startDraftStore,
} from "../start/start-session";

export class ContinuationError extends Error {}

export const continueInNewChat = async ({
  client,
  row,
  model,
  prompt,
  open,
}: {
  client: AppClient;
  row: SessionRow;
  model: string;
  prompt?: string;
  /** Opens the new chat's start page on the draft. */
  open(search: { workspace: string; draft: string }): Promise<unknown> | void;
}): Promise<void> => {
  const result = await client.agent.action({
    workspaceId: row.workspaceId,
    sessionId: row.id,
    action: "handoff",
  });
  if (!result.ok || result.summary == null)
    throw new ContinuationError(result.ok ? "empty" : result.reason);
  const draft = {
    ...newStartDraft(),
    workspaceId: row.workspaceId,
    worktree:
      row.worktreeId != null
        ? { kind: "existing" as const, id: row.worktreeId }
        : { kind: "current" as const },
    continuation: { sessionId: row.id, summary: result.summary },
  };
  startDraftStore.setState(() => draft);
  updateDraft(`draft:${draft.id}`, (current) => ({
    ...current,
    model,
    text: "",
  }));
  if (prompt != null) queueStartPrompt(draft.id, prompt);
  await open({ workspace: row.workspaceId, draft: draft.id });
};
