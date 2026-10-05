import type { Db } from "#renderer/data/db";
import type { AppClient } from "#renderer/data/transport/types";
import type { SessionRow } from "#shared/contract/rows";
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
    if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
  }
  await db.collections.sessions.delete(row.id).isPersisted.promise;
};
export const setSessionModel = async (
  db: Db,
  client: AppClient,
  row: SessionRow,
  model: string
): Promise<void> => {
  await db.collections.sessions.update(row.id, (d) => {
    d.model = model;
  }).isPersisted.promise;
  const results = await Promise.allSettled([
    client.settings.setDefaultModel({ modelId: model }),
    row.status === "running"
      ? client.agent.setModel({
          workspaceId: row.workspaceId,
          sessionId: row.id,
          model,
        })
      : Promise.resolve(),
  ]);
  const refused = results.find((r) => r.status === "rejected");
  if (refused?.status === "rejected") throw refused.reason;
};
