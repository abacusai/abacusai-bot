/**
 * R3-T11 by behaviour: bot writes branch on the typed code and data of the
 * error a contract procedure raises (as main raises it, with its status),
 * never on its message, and an untyped look-alike does not count.
 */
import { contract } from "@abacus-ai/contract/contract";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { call, implement, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import { createBot, forgetMemory, saveErrorOf } from "./bot-actions";

const os = implement(contract);

/** What a contract procedure that throws `error` rejects with. */
const raised = async (error: Error): Promise<unknown> => {
  const procedure = os.bots.chatPreviews.handler(() => {
    throw error;
  });
  return call(procedure, {}).then(
    () => expect.unreachable(),
    (rejected: unknown) => rejected
  );
};

const typed = {
  limit: () =>
    new ORPCError("PRECONDITION_FAILED", {
      status: 412,
      message: "Fifty bots",
      data: { reason: "bot-limit" },
    }),
  conflict: () =>
    new ORPCError("CONFLICT", {
      status: 409,
      message: "taken",
      data: { reason: "exists" },
    }),
  notFound: () =>
    new ORPCError("NOT_FOUND", {
      status: 404,
      message: "No bot b1",
      data: { entity: "bot", id: "b1" },
    }),
  badRequest: () =>
    new ORPCError("BAD_REQUEST", {
      status: 400,
      message: "bad name",
      data: { field: "name", detail: "too long" },
    }),
};

describe("saveErrorOf", () => {
  it.each([
    ["limit", typed.limit, { kind: "limit" }],
    ["conflict", typed.conflict, { kind: "conflict" }],
    ["not-found", typed.notFound, { kind: "not-found" }],
    ["bad-request", typed.badRequest, { kind: "bad-request", field: "name" }],
  ] as const)("maps main's %s", async (_, error, expected) => {
    expect(saveErrorOf(await raised(error()))).toEqual(expected);
  });

  it("reads a precondition other than the limit, and an untyped look-alike, as other", async () => {
    const other = new ORPCError("PRECONDITION_FAILED", {
      status: 412,
      message: "No workspace",
      data: { reason: "workspace-missing" },
    });
    expect(saveErrorOf(await raised(other))).toEqual({
      kind: "other",
      detail: "No workspace",
    });
    const lookAlike = Object.assign(new Error("bot-limit"), {
      code: "PRECONDITION_FAILED",
      data: { reason: "bot-limit" },
    });
    expect(saveErrorOf(lookAlike)).toEqual({
      kind: "other",
      detail: "bot-limit",
    });
  });
});

const row = { id: "bot-1" } as BotRow;
const insertWith = (first: unknown) => {
  const insert = vi.fn((inserted: BotRow) => ({
    isPersisted: {
      promise:
        insert.mock.calls.length === 1
          ? Promise.reject(first)
          : Promise.resolve(inserted),
    },
  }));
  return insert;
};

describe("createBot", () => {
  it("retries once with a fresh id when main says the id is taken", async () => {
    const insert = insertWith(await raised(typed.conflict()));
    expect(await createBot({ insert } as never, row, () => "bot-2")).toBe(
      "bot-2"
    );
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("does not retry another failure, or an untyped CONFLICT", async () => {
    for (const first of [
      await raised(typed.limit()),
      Object.assign(new Error("taken"), { code: "CONFLICT" }),
    ]) {
      const insert = insertWith(first);
      await expect(createBot({ insert } as never, row)).rejects.toBe(first);
      expect(insert).toHaveBeenCalledTimes(1);
    }
  });
});

describe("forgetMemory", () => {
  it("is stale on main's CONFLICT and rethrows anything else", async () => {
    const deleting = (error: unknown) => ({
      delete: () => ({ isPersisted: { promise: Promise.reject(error) } }),
    });
    expect(
      await forgetMemory(deleting(await raised(typed.conflict())) as never, {
        id: "m1",
      })
    ).toBe("stale");
    const missing = await raised(typed.notFound());
    await expect(
      forgetMemory(deleting(missing) as never, { id: "m1" })
    ).rejects.toBe(missing);
  });
});
