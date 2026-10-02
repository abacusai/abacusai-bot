import { DeleteKeyNotFoundError } from "@tanstack/db";
import { Store } from "@tanstack/react-store";

import type { Db } from "#next/data/db";
import type { BotRow } from "#shared/contract";

import { onboardingStore } from "./store";
export type FirstBotResult = { bot: BotRow; checkInRoutineId: string | null };
export type FirstBotState =
  | { state: "idle" }
  | { state: "pending"; promise: Promise<FirstBotResult | null> }
  | { state: "ready"; result: FirstBotResult }
  | { state: "skipped"; reason: "has_bots" | "no_template" | "create_failed" }
  | { state: "removed" };
export const firstBotStore = new Store<FirstBotState>({ state: "idle" });
export const ensureFirstBot = (
  ownsBot: boolean,
  create: (id: string) => Promise<FirstBotResult>
): void => {
  if (firstBotStore.state.state !== "idle") return;
  if (ownsBot) {
    firstBotStore.setState(() => ({ state: "skipped", reason: "has_bots" }));
    return;
  }
  const id = `bot-${crypto.randomUUID()}`;
  onboardingStore.setState((state) => ({ ...state, createdBotId: id }));
  // Store the pending state before invoking a mutation, including synchronous callbacks.
  let begin!: () => void;
  const promise = new Promise<FirstBotResult | null>((resolve) => {
    begin = () => {
      void create(id)
        .then((result) => {
          firstBotStore.setState(() => ({ state: "ready", result }));
          resolve(result);
        })
        .catch((error) => {
          firstBotStore.setState(() => ({
            state: "skipped",
            reason:
              (error as { code?: string }).code === "NOT_FOUND"
                ? "no_template"
                : "create_failed",
          }));
          resolve(null);
        });
    };
  });
  firstBotStore.setState(() => ({ state: "pending", promise }));
  begin();
};
const deletePersisted = async (
  collection: {
    has(id: string): boolean;
    delete(id: string): { isPersisted: { promise: Promise<unknown> } };
  },
  id: string
): Promise<void> => {
  if (!collection.has(id)) return;
  try {
    await collection.delete(id).isPersisted.promise;
  } catch (error) {
    if (
      error instanceof DeleteKeyNotFoundError ||
      (error as { code?: string }).code === "NOT_FOUND"
    )
      return;
    throw error;
  }
};
export const discardFirstBot = async (
  db: Db,
  result: FirstBotResult
): Promise<void> => {
  if (result.checkInRoutineId)
    await deletePersisted(db.collections.routines, result.checkInRoutineId);
  await deletePersisted(db.collections.bots, result.bot.id);
  firstBotStore.setState(() => ({ state: "removed" }));
};
