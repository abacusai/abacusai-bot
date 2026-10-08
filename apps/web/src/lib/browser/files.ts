import type { AppClient } from "#renderer/data/transport/types";
export interface UploadContext {
  workspaceId: string;
  sessionId: string;
}
export const uploadFiles = async (
  files: File[],
  context?: UploadContext
): Promise<string[]> => {
  if (!context?.workspaceId || !context.sessionId)
    throw new Error("Select a session before uploading files");
  const { refreshUploadToken } =
    await import("#renderer/features/shell/connect/services");
  let host = await refreshUploadToken();
  const body = new FormData();
  files.forEach((file) => body.append("files", file, file.name));
  const token = host.token;
  const upload = () =>
    fetch(`${host.base}/upload?${new URLSearchParams({ ...context })}`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${host.token}` },
      body,
    });
  let response = await upload();
  if ([401, 403].includes(response.status)) {
    host = await refreshUploadToken(true, token);
    response = await upload();
  }
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  const value = (await response.json()) as {
    success?: boolean;
    paths?: unknown;
    error?: string;
  };
  if (value.success !== true) throw new Error(value.error ?? "Upload failed");
  if (
    !Array.isArray(value.paths) ||
    !value.paths.every((path) => typeof path === "string")
  )
    throw new Error("Invalid upload response");
  return value.paths;
};
export const pickHostPaths = async (
  client: AppClient,
  mode: "folder" | "file",
  multiple = false
): Promise<string[] | null> => {
  const { pickPaths } = await import("./host-dialog");
  return pickPaths(client, mode, multiple);
};
export const pickHostFolder = async (
  client: AppClient
): Promise<string | null> =>
  (await pickHostPaths(client, "folder"))?.[0] ?? null;
export const viewHostFile = async (
  client: AppClient,
  path: string
): Promise<void> => {
  const { viewFile } = await import("./host-dialog");
  viewFile(client, path);
};
