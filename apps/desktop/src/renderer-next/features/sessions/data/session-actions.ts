import type { Db } from "#next/data/db";
import type { AppClient } from "#next/data/transport/types";
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
  if (row.status === "running")
    await client.agent.setModel({
      workspaceId: row.workspaceId,
      sessionId: row.id,
      model,
    });
  await client.settings.setDefaultModel({ modelId: model });
};
