import { Store } from "@tanstack/react-store";
import { expect, it, vi } from "vitest";

import { createDb } from "#next/data/db";
import { FixtureDb, fixtureTransport } from "#next/data/fixture-db/fixture-db";

import { startSession, newStartDraft, type StartDraft } from "./start-session";
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
