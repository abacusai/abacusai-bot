import { AgentMode } from "@abacus-ai/contract/agent-types";
import { afterEach, expect, it, vi } from "vitest";

import {
  draftStore,
  updateDraft,
} from "#renderer/features/chat/composer/draft-store";
import {
  captureDrafts,
  restoreDrafts,
} from "#renderer/lib/continuity/registry";

import {
  DRAFT_LIMIT,
  DRAFT_TTL,
  pruneSessionDrafts,
  removeSessionDraft,
  sessionDraftsStore,
  type SessionDraft,
} from "./session-drafts";
import {
  newStartDraft,
  openStartDraft,
  startDraftStore,
} from "./start-session";

afterEach(() => {
  vi.useRealTimers();
  sessionDraftsStore.setState(() => ({ activeId: null, drafts: {} }));
  draftStore.setState(() => ({}));
  startDraftStore.setState(newStartDraft);
});

it("focuses an empty draft and keeps invested drafts with isolated composer and checkout choices", () => {
  startDraftStore.setState(newStartDraft);
  const first = startDraftStore.state.id;
  expect(openStartDraft()).toBe(first);
  startDraftStore.setState((d) => ({
    ...d,
    workspaceId: "one",
    worktree: { kind: "existing", id: "branch-one" },
  }));
  updateDraft(`draft:${first}`, (d) => ({
    ...d,
    text: "First prompt",
    model: "first-model",
    mode: AgentMode.PlanMode,
    attachments: [
      { id: "file", name: "notes.txt", path: "/notes.txt", state: "done" },
    ],
  }));
  const second = openStartDraft(undefined, "two");
  expect(second).not.toBe(first);
  expect(draftStore.state[`draft:${second}`]?.text ?? "").toBe("");
  updateDraft(`draft:${second}`, (d) => ({
    ...d,
    text: "Second prompt",
    model: "second-model",
  }));
  openStartDraft(first);
  expect(startDraftStore.state.workspaceId).toBe("one");
  expect(startDraftStore.state.worktree).toEqual({
    kind: "existing",
    id: "branch-one",
  });
  expect(draftStore.state[`draft:${first}`]).toMatchObject({
    text: "First prompt",
    model: "first-model",
    mode: AgentMode.PlanMode,
    attachments: [{ id: "file" }],
  });
  expect(draftStore.state[`draft:${second}`]).toMatchObject({
    text: "Second prompt",
    model: "second-model",
    attachments: [],
  });
});

it("persists locally and restores through continuity without copying into a real conversation", () => {
  const id = startDraftStore.state.id;
  updateDraft(`draft:${id}`, (d) => ({
    ...d,
    text: "Survive restart",
    selectionStart: 4,
    attachments: [
      {
        id: "upload",
        name: "image.png",
        path: null,
        state: "uploading",
        preview: "blob:temporary",
      },
    ],
  }));
  updateDraft("real-session", (d) => ({ ...d, text: "Real conversation" }));
  sessionDraftsStore.flush();
  const saved = JSON.parse(
    localStorage.getItem("abacusai-bot:abacus.sessions.drafts")!
  );
  expect(saved.drafts[id].composer).toMatchObject({
    text: "Survive restart",
    selectionStart: 4,
    attachments: [{ state: "error", name: "image.png" }],
  });
  expect(saved.drafts[id].composer.attachments[0].preview).toBeUndefined();
  const snapshot = captureDrafts();
  sessionDraftsStore.setState(() => ({ activeId: null, drafts: {} }));
  restoreDrafts(snapshot);
  openStartDraft(id);
  expect(draftStore.state[`draft:${id}`]?.text).toBe("Survive restart");
  expect(draftStore.state["real-session"]?.text).toBe("Real conversation");
});

it("deletes and restores once within the undo window", () => {
  const id = startDraftStore.state.id;
  updateDraft(`draft:${id}`, (d) => ({ ...d, text: "Undo me" }));
  const undo = removeSessionDraft(id);
  expect(sessionDraftsStore.state.drafts[id]).toBeUndefined();
  const fresh = openStartDraft(id);
  expect(fresh).not.toBe(id);
  expect(undo()).toBe(true);
  expect(undo()).toBe(false);
  openStartDraft(id);
  expect(draftStore.state[`draft:${id}`]?.text).toBe("Undo me");
  const expired = removeSessionDraft(id);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7000);
  expect(expired()).toBe(false);
  vi.restoreAllMocks();
});

it("expires old drafts, removes abandoned empty drafts and caps oldest content while keeping the active draft", () => {
  const now = Date.now();
  const make = (id: string, updatedAt: number, text: string): SessionDraft => ({
    ...newStartDraft(),
    id,
    createdAt: updatedAt,
    updatedAt,
    composer: { text, attachments: [] },
  });
  const records = Array.from({ length: DRAFT_LIMIT + 3 }, (_, i) =>
    make(`draft-${i}`, now - i, "kept")
  );
  records.push(
    make("expired", now - DRAFT_TTL - 1, "Old"),
    make("empty", now, "  ")
  );
  const result = pruneSessionDrafts(
    {
      activeId: "draft-22",
      drafts: Object.fromEntries(records.map((d) => [d.id, d])),
    },
    now
  );
  expect(Object.keys(result.drafts)).toHaveLength(DRAFT_LIMIT);
  expect(result.drafts["expired"]).toBeUndefined();
  expect(result.drafts["empty"]).toBeUndefined();
  expect(result.drafts["draft-21"]).toBeUndefined();
  expect(result.drafts["draft-22"]).toBeDefined();
});
