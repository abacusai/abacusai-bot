import type { SessionRow } from "@abacus-ai/contract/contract/rows";

import type { Db } from "#renderer/data/db";
import { isRpcError } from "#renderer/data/query-client";
import type { AppClient } from "#renderer/data/transport/types";
export const renameSession = async (
  db: Db,
  id: string,
  label: string
): Promise<void> => {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Name can't be empty");
  await db.collections.sessions.update(id, (d) => {
    d.label = trimmed;
  }).isPersisted.promise;
};
export const deleteSession = async (
  db: Db,
  client: AppClient,
  row: SessionRow,
  navigate: () => void
): Promise<void> => {
  navigate();
  try {
    await client.agent.stop({
      workspaceId: row.workspaceId,
      sessionId: row.id,
    });
  } catch (error) {
    if (!isRpcError(error) || error.code !== "NOT_FOUND") throw error;
  }
  await db.collections.sessions.delete(row.id).isPersisted.promise;
};
/**
 * Move the chat onto `model`; a pick in the model picker becomes the app's
 * default too. `thisChatOnly` (the cut-off card's Switch) leaves the default.
 */
export const setSessionModel = async (
  db: Db,
  client: AppClient,
  row: SessionRow,
  model: string,
  { thisChatOnly = false }: { thisChatOnly?: boolean } = {}
): Promise<void> => {
  const previous = row.model ?? null;
  await db.collections.sessions.update(row.id, (d) => {
    d.model = model;
  }).isPersisted.promise;
  const results = await Promise.allSettled([
    thisChatOnly
      ? Promise.resolve()
      : client.settings.setDefaultModel({ modelId: model }),
    row.status === "running"
      ? client.agent.setModel({
          workspaceId: row.workspaceId,
          sessionId: row.id,
          model,
        })
      : Promise.resolve(),
  ]);
  // The running agent refused the pick: the picker must show the model the
  // chat is still on, not the one it was told no to.
  if (results[1].status === "rejected")
    await db.collections.sessions
      .update(row.id, (d) => {
        d.model = previous;
      })
      .isPersisted.promise.catch(() => undefined);
  const refused = results.find((r) => r.status === "rejected");
  if (refused?.status === "rejected") throw refused.reason;
};
