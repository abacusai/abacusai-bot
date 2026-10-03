import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "#next/data/db";
import { fixtureBots } from "#next/data/fixture-db/rows";

import { ensureFirstBot, firstBotStore, discardFirstBot } from "./first-bot";
import { onboardingStore } from "./store";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, no) => {
    resolve = r;
    reject = no;
  });
  return { promise, resolve, reject };
};
const result = { bot: fixtureBots()[0]!, checkInRoutineId: "routine" };
beforeEach(() => {
  firstBotStore.setState(() => ({ state: "idle" }));
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
});
describe("R6-T9 first-bot persistence", () => {
  it("shares one creation across remounts and sets the id before mutation", async () => {
    const gate = deferred<typeof result>();
    const create = vi.fn((id: string) => {
      expect(onboardingStore.state.createdBotId).toBe(id);
      expect(firstBotStore.state.state).toBe("pending");
      return gate.promise;
    });
    ensureFirstBot(false, create);
    ensureFirstBot(false, create);
    expect(create).toHaveBeenCalledOnce();
    gate.resolve(result);
    await vi.waitFor(() => expect(firstBotStore.state.state).toBe("ready"));
  });
  it("waits for routine persistence before deleting the bot", async () => {
    const gate = deferred<void>();
    const botDelete = vi.fn(() => ({
      isPersisted: { promise: Promise.resolve() },
    }));
    const routineDelete = vi.fn(() => ({
      isPersisted: { promise: gate.promise },
    }));
    const db = {
      collections: {
        routines: { has: () => true, delete: routineDelete },
        bots: { has: () => true, delete: botDelete },
      },
    } as unknown as Db;
    const pending = discardFirstBot(db, result);
    expect(routineDelete).toHaveBeenCalledOnce();
    expect(botDelete).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(botDelete).toHaveBeenCalledOnce();
  });
  it("a rejected routine transaction never deletes the bot", async () => {
    const botDelete = vi.fn();
    const db = {
      collections: {
        routines: {
          has: () => true,
          delete: () => ({
            isPersisted: { promise: Promise.reject(new Error("disk")) },
          }),
        },
        bots: { has: () => true, delete: botDelete },
      },
    } as unknown as Db;
    await expect(discardFirstBot(db, result)).rejects.toThrow("disk");
    expect(botDelete).not.toHaveBeenCalled();
  });
  it("already absent rows count as completed deletion", async () => {
    const remove = vi.fn();
    const db = {
      collections: {
        routines: { has: () => false, delete: remove },
        bots: { has: () => false, delete: remove },
      },
    } as unknown as Db;
    await discardFirstBot(db, result);
    expect(remove).not.toHaveBeenCalled();
    expect(firstBotStore.state.state).toBe("removed");
  });
  it("existing bots skip without creating", () => {
    const create = vi.fn();
    ensureFirstBot(true, create);
    expect(firstBotStore.state).toEqual({
      state: "skipped",
      reason: "has_bots",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
