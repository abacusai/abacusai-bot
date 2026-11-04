import { expect, it, vi } from "vitest";

import type { Db } from "#renderer/data/db";

import { setSessionModel } from "./session-actions";

const harness = (setModel: () => Promise<void>) => {
  const row = { id: "s", workspaceId: "w", status: "running", model: "a/old" };
  const models: unknown[] = [];
  const db = {
    collections: {
      sessions: {
        update: (_id: string, fn: (d: { model: string | null }) => void) => {
          const draft = { model: null as string | null };
          fn(draft);
          models.push(draft.model);
          return { isPersisted: { promise: Promise.resolve() } };
        },
      },
    },
  } as unknown as Db;
  const client = {
    settings: { setDefaultModel: vi.fn(async () => {}) },
    agent: { setModel: vi.fn(setModel) },
  };
  return { row, models, db, client };
};

it("a refused switch rolls the row back to the previous model and rejects", async () => {
  const h = harness(async () => {
    throw new Error("model-unavailable");
  });
  await expect(
    setSessionModel(h.db, h.client as never, h.row as never, "b/new")
  ).rejects.toThrow("model-unavailable");
  expect(h.models).toEqual(["b/new", "a/old"]);
  expect(h.client.agent.setModel).toHaveBeenCalledWith({
    workspaceId: "w",
    sessionId: "s",
    model: "b/new",
  });
});

it("a confirmed switch keeps the new model", async () => {
  const h = harness(async () => {});
  await setSessionModel(h.db, h.client as never, h.row as never, "b/new");
  expect(h.models).toEqual(["b/new"]);
});
