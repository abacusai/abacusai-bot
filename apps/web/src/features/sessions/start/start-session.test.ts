import { Store } from "@tanstack/react-store";
import { expect, it, vi } from "vitest";

import { createDb } from "#renderer/data/db";
import {
  FixtureDb,
  fixtureTransport,
} from "#renderer/data/fixture-db/fixture-db";
import {
  updateDraft,
  draftStore,
} from "#renderer/lib/continuity/composer-drafts";

import { sessionDraftsStore } from "./session-drafts";
import {
  startSession,
  startDraftStore,
  openStartDraft,
  newStartDraft,
  type StartDraft,
  optimisticSession,
  type SubmissionEnvelope,
} from "./start-session";
it("accepts a managed draft once and removes only that draft when another composer opens during handoff", async () => {
  const fixture = new FixtureDb();
  const db = createDb(fixtureTransport(fixture));
  const envelope: SubmissionEnvelope = {
    runId: "run",
    messageId: "message",
    parts: [{ type: "text", content: "First prompt" }],
  };
  const first = {
    ...newStartDraft(),
    workspaceId: "w",
    stage: "checkout-ready" as const,
    envelope,
  };
  startDraftStore.setState(() => first);
  updateDraft(`draft:${first.id}`, (d) => ({ ...d, text: "First prompt" }));
  let accept!: () => void;
  const receipt = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const handoff = vi.fn(() => receipt);
  const navigate = vi.fn();
  const deps = { db, client: {} as never, handoff, navigate };
  const send = startSession(deps);
  const repeat = startSession(deps);
  const next = openStartDraft(undefined, "other-workspace");
  updateDraft(`draft:${next}`, (d) => ({ ...d, text: "Second prompt" }));
  try {
    accept();
    await Promise.all([send, repeat]);
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith(first.id, envelope);
    expect(sessionDraftsStore.state.drafts[first.id]).toBeUndefined();
    expect(startDraftStore.state.id).toBe(next);
    expect(draftStore.state[`draft:${next}`]?.text).toBe("Second prompt");
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    startDraftStore.setState(newStartDraft);
    db.stop();
    for (const collection of Object.values(db.collections))
      await collection.cleanup();
  }
});
it("R4-T12/R4-T13 resumes an attached checkout after failure and persists model/mode", async () => {
  const fixture = new FixtureDb();
  const db = createDb(fixtureTransport(fixture));
  const draft: StartDraft = {
    ...newStartDraft(),
    workspaceId: "w",
    worktree: { kind: "new", baseRef: "main" },
  };
  const store = new Store(draft);
  const materialize = vi.fn(async (input) => {
    fixture.sessions.upsert({
      ...fixture.sessions.rows.get(input.sessionId)!,
      worktreeId: "tree",
      worktreeOperationId: input.operationId,
    });
    throw Error("Lost response");
  });
  const client = {
    git: { worktrees: { materialize } },
    terminal: { promoteScope: vi.fn(async () => null) },
    browser: { runtime: { promoteScope: vi.fn(async () => []) } },
  };
  const handoff = vi.fn();
  const navigate = vi.fn();
  const deps = { db, client: client as never, store, handoff, navigate };
  const envelope = {
    runId: "r",
    messageId: "m",
    parts: [{ type: "text" as const, content: "first" }],
    forwardedProps: { model: "provider/model", mode: "PLAN" },
  };
  await expect(startSession(deps, envelope)).rejects.toThrow("Lost response");
  expect(store.state.stage).toBe("created");
  await db.collections.sessions.utils.resync();
  await startSession(deps);
  expect(materialize).toHaveBeenCalledTimes(1);
  expect(fixture.sessions.rows.size).toBe(1);
  expect([...fixture.sessions.rows.values()][0]).toMatchObject({
    model: "provider/model",
    mode: "PLAN",
  });
  expect(handoff).toHaveBeenCalledWith(draft.id, envelope);
  expect(navigate).toHaveBeenCalledWith(draft.id);
  db.stop();
  for (const c of Object.values(db.collections)) await c.cleanup();
});
it("failed materialization resumes with explicit detach without inserting or materializing again", async () => {
  const fixture = new FixtureDb();
  const db = createDb(fixtureTransport(fixture));
  const draft = {
    ...newStartDraft(),
    workspaceId: "w",
    worktree: { kind: "new" as const, baseRef: "main" },
  };
  const store = new Store<StartDraft>(draft);
  const materialize = vi
    .fn()
    .mockResolvedValue({ success: false, error: "no disk" });
  const setForSession = vi.fn().mockResolvedValue({ success: true });
  const handoff = vi.fn();
  const deps = {
    db,
    store,
    handoff,
    navigate: vi.fn(),
    client: {
      git: { worktrees: { materialize, setForSession } },
      terminal: { promoteScope: vi.fn() },
      browser: { runtime: { promoteScope: vi.fn() } },
    } as never,
  };
  try {
    await expect(
      startSession(deps, {
        runId: "r",
        messageId: "m",
        parts: [{ type: "text", content: "saved" }],
      })
    ).rejects.toThrow("no disk");
    store.setState((s) => ({ ...s, worktree: { kind: "current" } }));
    await startSession(deps);
    expect(setForSession).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w",
      sessionId: draft.id,
      worktreeId: null,
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(fixture.sessions.rows.size).toBe(1);
    expect(handoff).toHaveBeenCalledOnce();
  } finally {
    db.stop();
    for (const c of Object.values(db.collections)) await c.cleanup();
  }
});

it("two documents resume an existing session with one host admission identity", async () => {
  const fixture = new FixtureDb();
  const db = createDb(fixtureTransport(fixture));
  const draft: StartDraft = {
    ...newStartDraft(),
    workspaceId: "w",
    stage: "checkout-ready",
    envelope: {
      runId: "saved-run",
      messageId: "saved-message",
      parts: [{ type: "text", content: "hello" }],
    },
  };
  fixture.sessions.upsert(optimisticSession(draft));
  const admitted = new Set<string>();
  const delivered: string[] = [];
  const handoff = vi.fn(async (id: string, envelope: SubmissionEnvelope) => {
    if (!admitted.has(id)) {
      admitted.add(id);
      delivered.push(envelope.messageId);
    }
  });
  const first = new Store(structuredClone(draft));
  const second = new Store(structuredClone(draft));
  const deps = { db, client: {} as never, handoff, navigate: vi.fn() };
  try {
    await Promise.all([
      startSession({ ...deps, store: first }),
      startSession({ ...deps, store: second }),
    ]);
    expect(fixture.sessions.rows.size).toBe(1);
    expect(delivered).toEqual(["saved-message"]);
    expect(handoff).toHaveBeenNthCalledWith(1, draft.id, draft.envelope);
    expect(handoff).toHaveBeenNthCalledWith(2, draft.id, draft.envelope);
  } finally {
    db.stop();
    for (const collection of Object.values(db.collections))
      await collection.cleanup();
  }
});
