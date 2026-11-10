/**
 * Continuing a chat in a new one: the old chat's summary is asked for first,
 * and only then does a draft open in the same folder and checkout, on the
 * chosen model, with the summary going in with its first message, and the
 * stuck message queued to send when there is one.
 */
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { describe, expect, it, vi } from "vitest";

import type { AppClient } from "#renderer/data/transport/types";
import { draftStore } from "#renderer/lib/continuity/composer-drafts";

import {
  optimisticSession,
  startDraftStore,
  takeStartPrompt,
} from "../start/start-session";
import { ContinuationError, continueInNewChat } from "./continue-chat";

const ROW = {
  id: "old-chat",
  workspaceId: "w1",
  worktreeId: "wt-1",
} as SessionRow;
const OPUS = "abacus/claude-opus-5-5";
const SUMMARY = "## Goal\nFix the login crash.";

const client = (result: unknown) => {
  const action = vi.fn(async () => result);
  return { action, client: { agent: { action } } as unknown as AppClient };
};

describe("continueInNewChat", () => {
  it("opens a draft on the model, in the same checkout, carrying the summary and the stuck message", async () => {
    const { action, client: app } = client({ ok: true, summary: SUMMARY });
    const open = vi.fn();
    await continueInNewChat({
      client: app,
      row: ROW,
      model: OPUS,
      prompt: "It still doesn't work, same error",
      open,
    });
    expect(action).toHaveBeenCalledWith({
      workspaceId: "w1",
      sessionId: "old-chat",
      action: "handoff",
    });
    const draft = startDraftStore.state;
    expect(draft).toMatchObject({
      workspaceId: "w1",
      worktree: { kind: "existing", id: "wt-1" },
      continuation: { sessionId: "old-chat", summary: SUMMARY },
      stage: "draft",
    });
    expect(draftStore.state[`draft:${draft.id}`]?.model).toBe(OPUS);
    expect(takeStartPrompt(`draft:${draft.id}`)).toBe(
      "It still doesn't work, same error"
    );
    expect(open).toHaveBeenCalledWith({ workspace: "w1", draft: draft.id });
    // What the insert carries: the summary for main, the link for the lists.
    expect(optimisticSession(draft)).toMatchObject({
      continuation: { sessionId: "old-chat", summary: SUMMARY },
      continuedFrom: "old-chat",
    });
  });

  it("waits for the user's words when there is no message to send", async () => {
    const { client: app } = client({ ok: true, summary: SUMMARY });
    await continueInNewChat({
      client: app,
      row: { ...ROW, worktreeId: null },
      model: OPUS,
      open: () => undefined,
    });
    const draft = startDraftStore.state;
    expect(draft.worktree).toEqual({ kind: "current" });
    expect(takeStartPrompt(`draft:${draft.id}`)).toBeNull();
  });

  it("opens nothing when the summary could not be written", async () => {
    const before = startDraftStore.state.id;
    for (const result of [
      { ok: false, reason: "failed" },
      { ok: false, reason: "busy" },
      { ok: true },
    ]) {
      const { client: app } = client(result);
      const open = vi.fn();
      await expect(
        continueInNewChat({ client: app, row: ROW, model: OPUS, open })
      ).rejects.toBeInstanceOf(ContinuationError);
      expect(open).not.toHaveBeenCalled();
      expect(startDraftStore.state.id).toBe(before);
    }
  });
});
